// tus client for a butterfly-share server. Only used once the user configures a destination.

export interface ShareDestination {
  /** No trailing slash. */
  serverUrl: string
  token: string
}

export interface ShareHandle {
  shareKey: string
  /** Valid immediately, before the upload finishes. */
  shareUrl: string
  uploadUrl: string
}

export interface ShareMetadata {
  id: string
  title: string
  duration?: number
  width?: number
  height?: number
  password?: string
  expiresAt?: string
  allowDownload?: boolean
}

export interface UploadOptions {
  /** 0..1. */
  onProgress?: (progress: number) => void
  signal?: AbortSignal
  /** Bytes per PATCH. */
  chunkSize?: number
}

const TUS_VERSION = '1.0.0'
const DEFAULT_CHUNK = 8 * 1024 * 1024

export class ShareError extends Error {
  // Not a parameter property: Node's type stripping (used by the tests) cannot run those.
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ShareError'
    this.status = status
  }
}

function encodeMetadata(metadata: ShareMetadata): string {
  const pairs: Array<[string, string]> = [
    ['id', metadata.id],
    ['title', metadata.title],
  ]
  if (metadata.duration !== undefined) pairs.push(['duration', String(metadata.duration)])
  if (metadata.width !== undefined) pairs.push(['width', String(metadata.width)])
  if (metadata.height !== undefined) pairs.push(['height', String(metadata.height)])
  if (metadata.password) pairs.push(['password', metadata.password])
  if (metadata.expiresAt) pairs.push(['expiresAt', metadata.expiresAt])
  if (metadata.allowDownload === false) pairs.push(['allowDownload', 'false'])

  // btoa only accepts latin1, so values are encoded to UTF-8 bytes first.
  return pairs
    .map(([key, value]) => `${key} ${base64(value)}`)
    .join(',')
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function headers(destination: ShareDestination, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${destination.token}`,
    'Tus-Resumable': TUS_VERSION,
    ...extra,
  }
}

/** Uses `Upload-Defer-Length` so the share URL exists before the recording ends. */
export async function createShare(
  destination: ShareDestination,
  metadata: ShareMetadata,
): Promise<ShareHandle> {
  const response = await fetch(`${destination.serverUrl}/v1/uploads`, {
    method: 'POST',
    headers: headers(destination, {
      'Upload-Defer-Length': '1',
      'Upload-Metadata': encodeMetadata(metadata),
    }),
  })

  if (!response.ok) {
    throw new ShareError(
      response.status === 401
        ? 'The server rejected the upload token.'
        : `The share server refused to create the upload (${response.status}).`,
      response.status,
    )
  }

  return (await response.json()) as ShareHandle
}

export async function currentOffset(
  destination: ShareDestination,
  handle: ShareHandle,
): Promise<number> {
  const response = await fetch(handle.uploadUrl, {
    method: 'HEAD',
    headers: headers(destination),
  })
  if (!response.ok) throw new ShareError('That upload no longer exists on the server.', response.status)
  return Number(response.headers.get('Upload-Offset') ?? 0)
}

export async function uploadShare(
  destination: ShareDestination,
  handle: ShareHandle,
  file: Blob,
  options: UploadOptions = {},
): Promise<void> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK
  let offset = await currentOffset(destination, handle)

  while (offset < file.size) {
    options.signal?.throwIfAborted()

    const end = Math.min(offset + chunkSize, file.size)
    const isLast = end >= file.size

    const response = await fetch(handle.uploadUrl, {
      method: 'PATCH',
      headers: headers(destination, {
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offset),
        // Resolves the deferred length.
        ...(isLast ? { 'Upload-Length': String(file.size) } : {}),
      }),
      body: file.slice(offset, end),
      ...(options.signal ? { signal: options.signal } : {}),
    })

    if (response.status === 409) {
      // Offset mismatch: the server's offset is authoritative.
      offset = Number(response.headers.get('Upload-Offset') ?? 0)
      continue
    }

    if (!response.ok && response.status !== 204) {
      throw new ShareError(`Upload failed (${response.status}).`, response.status)
    }

    offset = Number(response.headers.get('Upload-Offset') ?? end)
    options.onProgress?.(file.size === 0 ? 1 : offset / file.size)
  }
}

export async function finalizeShare(
  destination: ShareDestination,
  handle: ShareHandle,
  patch: { title?: string; duration?: number; width?: number; height?: number },
): Promise<void> {
  const response = await fetch(`${handle.uploadUrl}/meta`, {
    method: 'PATCH',
    headers: headers(destination, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ...patch, finalize: true }),
  })
  if (!response.ok) throw new ShareError(`Could not finalize the share (${response.status}).`)
}

export async function deleteShare(
  destination: ShareDestination,
  handle: Pick<ShareHandle, 'uploadUrl'>,
): Promise<void> {
  await fetch(handle.uploadUrl, { method: 'DELETE', headers: headers(destination) })
}

export async function testDestination(destination: ShareDestination): Promise<boolean> {
  try {
    const response = await fetch(`${destination.serverUrl}/healthz`)
    return response.ok
  } catch {
    return false
  }
}

export { encodeMetadata as encodeShareMetadata }
