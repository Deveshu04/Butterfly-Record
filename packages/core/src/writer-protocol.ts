export type WriterRequest =
  | { id: number; type: 'open'; path: string[] }
  | { id: number; type: 'write'; buffer: ArrayBuffer }
  | { id: number; type: 'flush' }
  | { id: number; type: 'close' }
  /** Close and delete the part file. */
  | { id: number; type: 'abort' }

export type WriterResponse =
  | { id: number; type: 'ok'; bytesWritten: number }
  | { id: number; type: 'error'; name: string; message: string; bytesWritten: number }

/** Distributive because a bare `Omit<WriterRequest, 'id'>` collapses the union to its shared keys. */
export type WriterRequestBody = WriterRequest extends infer T
  ? T extends WriterRequest
    ? Omit<T, 'id'>
    : never
  : never
