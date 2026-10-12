import { cameraBackgroundRead } from '../ipc.ts'

/** Longest side a background picture is kept at; anything larger only costs memory. */
const MAX_SIDE = 2560

/** The chosen picture, decoded and scaled down if it is very large. */
export async function loadBackgroundImage(name: string): Promise<ImageBitmap> {
  const bytes = await cameraBackgroundRead(name)
  const full = await createImageBitmap(new Blob([bytes]))
  const scale = MAX_SIDE / Math.max(full.width, full.height)
  if (scale >= 1) return full
  try {
    return await createImageBitmap(full, {
      resizeWidth: Math.max(1, Math.round(full.width * scale)),
      resizeHeight: Math.max(1, Math.round(full.height * scale)),
      resizeQuality: 'high',
    })
  } finally {
    full.close()
  }
}
