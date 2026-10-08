// Shell-agnostic: browser APIs only, no Chrome extension or desktop runtime APIs.

export const VERSION = '0.1.0'

export { ULID_LENGTH, isUlid, ulid, ulidTime } from './ids.ts'

export {
  MANIFEST_SCHEMA,
  createManifest,
  defaultTitle,
  isTrashed,
  normalizeManifest,
  type AudioCodecName,
  type AudioContribution,
  type AudioTrackKind,
  type CaptureSurface,
  type ContainerName,
  type FinalizedFields,
  type NewRecordingInit,
  type PauseSpan,
  type RecordingManifest,
  type RecordingStatus,
  type VideoCodecName,
} from './manifest.ts'

export { audioBitrateFor, bitrateFor, secondsRemaining, type VideoShape } from './bitrate.ts'

export { safeFilename, safeFilenameWithExtension } from './filenames.ts'

export { canExportMp4, pickRecordingCodec, type RecordingCodecChoice } from './codecs.ts'

export {
  AudioMixer,
  composeRecordingStream,
  type MixerInput,
  type MixerOptions,
} from './audio-mixer.ts'

export {
  DEV_REPORT_FILE,
  EDL_FILE,
  EXPORT_FILE,
  FOLDERS_FILE,
  LIBRARY_DIR,
  MANIFEST_FILE,
  PART_FILE,
  PEAKS_FILE,
  POSTER_FILE,
  PREVIEW_FILE,
  SESSIONS_DIR,
  SOURCE_FILE,
  TRANSCRIPT_FILE,
  directoryFor,
  fileHandle,
  isNotFound,
  isQuotaExceeded,
  libraryPath,
  listSessionIds,
  readFile,
  readJson,
  removeFile,
  removeSession,
  requestPersistence,
  sessionPath,
  storageBudget,
  writeJson,
  type StorageBudget,
} from './opfs.ts'

export {
  FOLDERS_SCHEMA,
  ancestorIds,
  cleanFolderName,
  createFolder,
  deleteFolder,
  folderAndDescendants,
  folderOf,
  folderPath,
  folderTree,
  listFolders,
  moveFolder,
  renameFolder,
  type Folder,
  type FolderNode,
} from './folders.ts'

export { OpfsChunkSink, SinkFullError, type ChunkSink } from './chunk-sink.ts'

export {
  InsufficientSpaceError,
  TRASH_RETENTION_DAYS,
  daysUntilPurge,
  deleteRecording,
  devReportPath,
  emptyTrash,
  formatBytes,
  formatDuration,
  invalidateDerived,
  listRecordings,
  listTrash,
  moveToFolder,
  purgeExpiredTrash,
  readEntry,
  readPeaksFile,
  readPoster,
  readPreview,
  readSessionBlob,
  readSource,
  recoverRecording,
  renameRecording,
  restoreRecording,
  setDescription,
  setPosterTime,
  totalBytes,
  trashRecording,
  updateManifest,
  writePoster,
  writePreview,
  writeSessionBlob,
  type LibraryEntry,
  type ListOptions,
} from './library.ts'

export { generatePoster, type PosterOptions } from './poster.ts'

export { generatePreview, type PreviewOptions } from './preview.ts'

export {
  EDL_SCHEMA,
  EditHistory,
  autoEdits,
  cutCount,
  fullEdl,
  hasAutoEdits,
  isUnedited,
  normalize,
  outputDuration,
  outputToSource,
  removeRange,
  removeRanges,
  removedRanges,
  restoreRanges,
  sourceToOutput,
  splitAt,
  trimSegment,
  withAutoEdits,
  type AutoEdits,
  type Edl,
  type EditSegment,
  type FillerLevel,
  type SilenceOptions,
} from './edl.ts'

export {
  deleteTranscript,
  readEdl,
  readTranscript,
  revertEdits,
  writeEdl,
  writeTranscript,
} from './library.ts'

export {
  TRANSCRIPT_SCHEMA,
  applyEdlToTranscript,
  autoTitle,
  emptyTranscript,
  parseSrt,
  searchTranscript,
  toPlainText,
  toSrt,
  toVtt,
  transcriptText,
  type SubtitleCue,
  type Transcript,
  type TranscriptMatch,
  type TranscriptSegment,
  type TranscriptWord,
} from './transcript.ts'

export {
  ShareError,
  createShare,
  currentOffset,
  deleteShare,
  encodeShareMetadata,
  finalizeShare,
  testDestination,
  uploadShare,
  type ShareDestination,
  type ShareHandle,
  type ShareMetadata,
  type UploadOptions,
} from './share-client.ts'

export {
  SerialQueue,
  Stopwatch,
  type EncodeOptions,
  type Encoder,
  type EncoderFault,
  type EncoderPhase,
} from './encoder.ts'

export { MediaRecorderEncoder } from './media-recorder-encoder.ts'

// transcribe.ts, edit-export.ts and finalize.ts are not re-exported because they pull in
// transformers.js or Mediabunny. Import them by subpath, e.g. `@butterfly-record/core/finalize`.
