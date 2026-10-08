import { DatabaseSync } from 'node:sqlite'

import { PRAGMAS, TABLES } from './schema.ts'

export type RecordingStatus = 'uploading' | 'ready' | 'failed'

export interface ShareRecord {
  shareKey: string
  recordingId: string
  title: string
  createdAt: string
  duration: number | null
  width: number | null
  height: number | null
  contentType: string
  status: RecordingStatus
  uploadOffset: number
  /** Null while the client is still using Upload-Defer-Length. */
  uploadLength: number | null
  passwordHash: string | null
  passwordSalt: string | null
  expiresAt: string | null
  allowDownload: boolean
  views: number
  watches: number
}

interface Row {
  share_key: string
  recording_id: string
  title: string
  created_at: string
  duration: number | null
  width: number | null
  height: number | null
  content_type: string
  status: string
  upload_offset: number
  upload_length: number | null
  password_hash: string | null
  password_salt: string | null
  expires_at: string | null
  allow_download: number
  views: number
  watches: number
}

function toRecord(row: Row): ShareRecord {
  return {
    shareKey: row.share_key,
    recordingId: row.recording_id,
    title: row.title,
    createdAt: row.created_at,
    duration: row.duration,
    width: row.width,
    height: row.height,
    contentType: row.content_type,
    status: row.status as RecordingStatus,
    uploadOffset: row.upload_offset,
    uploadLength: row.upload_length,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    expiresAt: row.expires_at,
    allowDownload: row.allow_download === 1,
    views: row.views,
    watches: row.watches,
  }
}

export class Store {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    for (const pragma of PRAGMAS) this.#db.prepare(pragma).get()
    for (const table of TABLES) this.#db.prepare(table).run()
  }

  close(): void {
    this.#db.close()
  }

  create(input: {
    shareKey: string
    recordingId: string
    title: string
    contentType: string
    uploadLength: number | null
    duration: number | null
    width: number | null
    height: number | null
    expiresAt: string | null
    allowDownload: boolean
    password: { hash: string; salt: string } | null
  }): ShareRecord {
    this.#db
      .prepare(
        `INSERT INTO recordings (
           share_key, recording_id, title, created_at, duration, width, height,
           content_type, status, upload_offset, upload_length,
           password_hash, password_salt, expires_at, allow_download
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.shareKey,
        input.recordingId,
        input.title,
        new Date().toISOString(),
        input.duration,
        input.width,
        input.height,
        input.contentType,
        input.uploadLength,
        input.password?.hash ?? null,
        input.password?.salt ?? null,
        input.expiresAt,
        input.allowDownload ? 1 : 0,
      )

    return this.get(input.shareKey)!
  }

  get(shareKey: string): ShareRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM recordings WHERE share_key = ?')
      .get(shareKey) as Row | undefined
    return row ? toRecord(row) : null
  }

  setOffset(shareKey: string, offset: number): void {
    this.#db
      .prepare('UPDATE recordings SET upload_offset = ? WHERE share_key = ?')
      .run(offset, shareKey)
  }

  setLength(shareKey: string, length: number): void {
    this.#db
      .prepare('UPDATE recordings SET upload_length = ? WHERE share_key = ?')
      .run(length, shareKey)
  }

  setStatus(shareKey: string, status: RecordingStatus): void {
    this.#db.prepare('UPDATE recordings SET status = ? WHERE share_key = ?').run(status, shareKey)
  }

  updateMetadata(
    shareKey: string,
    patch: { title?: string; duration?: number; width?: number; height?: number },
  ): void {
    const sets: string[] = []
    const values: Array<string | number> = []
    if (patch.title !== undefined) {
      sets.push('title = ?')
      values.push(patch.title)
    }
    if (patch.duration !== undefined) {
      sets.push('duration = ?')
      values.push(patch.duration)
    }
    if (patch.width !== undefined) {
      sets.push('width = ?')
      values.push(patch.width)
    }
    if (patch.height !== undefined) {
      sets.push('height = ?')
      values.push(patch.height)
    }
    if (sets.length === 0) return
    values.push(shareKey)
    this.#db.prepare(`UPDATE recordings SET ${sets.join(', ')} WHERE share_key = ?`).run(...values)
  }

  remove(shareKey: string): void {
    this.#db.prepare('DELETE FROM recordings WHERE share_key = ?').run(shareKey)
  }

  /**
   * Returns true on this viewer's first view today. INSERT OR IGNORE keeps it
   * idempotent and race-free, since one play issues several Range requests.
   */
  markView(shareKey: string, fingerprint: string, day: string): boolean {
    const result = this.#db
      .prepare('INSERT OR IGNORE INTO view_marks (share_key, fingerprint, day) VALUES (?, ?, ?)')
      .run(shareKey, fingerprint, day)

    if (result.changes === 0) return false
    this.#db.prepare('UPDATE recordings SET views = views + 1 WHERE share_key = ?').run(shareKey)
    return true
  }

  markWatched(shareKey: string, fingerprint: string): boolean {
    const result = this.#db
      .prepare(
        'UPDATE view_marks SET watched = 1 WHERE share_key = ? AND fingerprint = ? AND watched = 0',
      )
      .run(shareKey, fingerprint)

    if (result.changes === 0) return false
    this.#db.prepare('UPDATE recordings SET watches = watches + 1 WHERE share_key = ?').run(shareKey)
    return true
  }

  expired(now: string = new Date().toISOString()): string[] {
    const rows = this.#db
      .prepare('SELECT share_key FROM recordings WHERE expires_at IS NOT NULL AND expires_at < ?')
      .all(now) as Array<{ share_key: string }>
    return rows.map((row) => row.share_key)
  }
}
