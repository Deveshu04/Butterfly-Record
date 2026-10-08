// File.slice() rather than a sync access handle, which is exclusive and would block the session.

import { CustomSource } from 'mediabunny'

export function sourceForFile(file: File): CustomSource {
  return new CustomSource({
    getSize: () => file.size,
    read: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
  })
}
