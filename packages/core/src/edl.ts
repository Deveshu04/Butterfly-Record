// Non-destructive edit decision list. All times are seconds on the SOURCE timeline.

export const EDL_SCHEMA = 1

/** A kept range of the source. Segments are ordered and never overlap. */
export interface EditSegment {
  start: number
  end: number
}

/** `light`: unambiguous disfluencies only. `aggressive`: also discourse fillers and repeats. */
export type FillerLevel = 'light' | 'aggressive'

export interface SilenceOptions {
  /** Only gaps at least this long are cut, in seconds. */
  minGap: number
  /** Seconds of silence kept at each end of a cut. */
  padding: number
}

/**
 * Active transcript-driven cuts and the exact ranges they removed, so turning one off
 * restores what it took rather than recomputing from a possibly regenerated transcript.
 */
export interface AutoEdits {
  filler: FillerLevel | null
  silence: SilenceOptions | null
  /** Source ranges removed by the settings above, in source order. */
  ranges: EditSegment[]
}

export interface Edl {
  schema: typeof EDL_SCHEMA
  /** Source duration the EDL was built against, for validation on load. */
  sourceDuration: number
  segments: EditSegment[]
  /** Omitted while no transcript-driven removal is on, keeping older EDL files byte-identical. */
  auto?: AutoEdits
}

/** Shorter than one frame at 240fps. */
const EPSILON = 1e-4

export function fullEdl(sourceDuration: number): Edl {
  return {
    schema: EDL_SCHEMA,
    sourceDuration,
    segments: sourceDuration > 0 ? [{ start: 0, end: sourceDuration }] : [],
  }
}

export function isUnedited(edl: Edl): boolean {
  return (
    edl.segments.length === 1 &&
    edl.segments[0]!.start <= EPSILON &&
    edl.segments[0]!.end >= edl.sourceDuration - EPSILON
  )
}

/** Sorts, clamps, drops empty segments and merges ones that touch. */
export function normalize(edl: Edl): Edl {
  const clamped = edl.segments
    .map((segment) => ({
      start: Math.max(0, Math.min(segment.start, edl.sourceDuration)),
      end: Math.max(0, Math.min(segment.end, edl.sourceDuration)),
    }))
    .filter((segment) => segment.end - segment.start > EPSILON)
    .sort((a, b) => a.start - b.start)

  const merged: EditSegment[] = []
  for (const segment of clamped) {
    const last = merged[merged.length - 1]
    if (last && segment.start <= last.end + EPSILON) {
      last.end = Math.max(last.end, segment.end)
    } else {
      merged.push({ ...segment })
    }
  }

  return { ...edl, segments: merged }
}

/** Cuts `[from, to)` out of the output. Splits a segment it lands inside. */
export function removeRange(edl: Edl, from: number, to: number): Edl {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  if (hi - lo <= EPSILON) return edl

  const segments: EditSegment[] = []
  for (const segment of edl.segments) {
    if (segment.end <= lo + EPSILON || segment.start >= hi - EPSILON) {
      segments.push({ ...segment })
      continue
    }
    if (segment.start < lo) segments.push({ start: segment.start, end: lo })
    if (segment.end > hi) segments.push({ start: hi, end: segment.end })
  }

  return normalize({ ...edl, segments })
}

export function removeRanges(edl: Edl, ranges: readonly EditSegment[]): Edl {
  let next = edl
  for (const range of ranges) next = removeRange(next, range.start, range.end)
  return next
}

/**
 * Inverse of `removeRanges` up to normalisation. A union rather than a reverse replay,
 * so manual edits made outside these ranges in the meantime are preserved.
 */
export function restoreRanges(edl: Edl, ranges: readonly EditSegment[]): Edl {
  return normalize({ ...edl, segments: [...edl.segments, ...ranges.map((r) => ({ ...r }))] })
}

export function autoEdits(edl: Edl): AutoEdits {
  return edl.auto ?? { filler: null, silence: null, ranges: [] }
}

export function hasAutoEdits(edl: Edl): boolean {
  const auto = autoEdits(edl)
  return auto.filler !== null || auto.silence !== null
}

/** Drops the `auto` key once everything is off, so the EDL matches one never toggled. */
export function withAutoEdits(edl: Edl, auto: AutoEdits): Edl {
  if (auto.filler === null && auto.silence === null) {
    const { auto: _dropped, ...rest } = edl
    return rest
  }
  return { ...edl, auto }
}

/** Splits the segment containing `time`. The exported output is unchanged by a split alone. */
export function splitAt(edl: Edl, time: number): Edl {
  const segments: EditSegment[] = []
  for (const segment of edl.segments) {
    if (time > segment.start + EPSILON && time < segment.end - EPSILON) {
      segments.push({ start: segment.start, end: time })
      segments.push({ start: time, end: segment.end })
    } else {
      segments.push({ ...segment })
    }
  }
  // Not normalize(): it would merge the two halves back together.
  return { ...edl, segments }
}

/** Moves one segment's edge, without letting it cross its neighbours. */
export function trimSegment(
  edl: Edl,
  index: number,
  edge: 'start' | 'end',
  time: number,
): Edl {
  const segment = edl.segments[index]
  if (!segment) return edl

  const previous = edl.segments[index - 1]
  const next = edl.segments[index + 1]

  const segments = edl.segments.map((s) => ({ ...s }))
  const target = segments[index]!

  if (edge === 'start') {
    const floor = previous ? previous.end : 0
    target.start = Math.max(floor, Math.min(time, segment.end - EPSILON))
  } else {
    const ceiling = next ? next.start : edl.sourceDuration
    target.end = Math.min(ceiling, Math.max(time, segment.start + EPSILON))
  }

  return { ...edl, segments }
}

export function outputDuration(edl: Edl): number {
  return edl.segments.reduce((total, segment) => total + (segment.end - segment.start), 0)
}

/** How many cuts the viewer will experience, including leading and trailing trims. */
export function cutCount(edl: Edl): number {
  if (edl.segments.length === 0) return 0
  let cuts = 0
  if (edl.segments[0]!.start > EPSILON) cuts++
  for (let i = 1; i < edl.segments.length; i++) {
    if (edl.segments[i]!.start > edl.segments[i - 1]!.end + EPSILON) cuts++
  }
  if (edl.segments[edl.segments.length - 1]!.end < edl.sourceDuration - EPSILON) cuts++
  return cuts
}

/** Source time → output time, or null when that moment was cut out. */
export function sourceToOutput(edl: Edl, sourceTime: number): number | null {
  let elapsed = 0
  for (const segment of edl.segments) {
    if (sourceTime < segment.start) return null
    if (sourceTime <= segment.end) return elapsed + (sourceTime - segment.start)
    elapsed += segment.end - segment.start
  }
  return null
}

/**
 * Output time → source time, clamped to the end. A time exactly on a cut resolves to
 * the moment after it; resolving before would park a playhead on the pre-cut frame.
 */
export function outputToSource(edl: Edl, outputTime: number): number {
  let remaining = Math.max(0, outputTime)
  for (const segment of edl.segments) {
    const length = segment.end - segment.start
    if (remaining < length) return segment.start + remaining
    remaining -= length
  }
  return edl.segments[edl.segments.length - 1]?.end ?? 0
}

/** The removed source ranges, at full width, for the timeline to grey out. */
export function removedRanges(edl: Edl): EditSegment[] {
  const gaps: EditSegment[] = []
  let cursor = 0
  for (const segment of edl.segments) {
    if (segment.start > cursor + EPSILON) gaps.push({ start: cursor, end: segment.start })
    cursor = Math.max(cursor, segment.end)
  }
  if (cursor < edl.sourceDuration - EPSILON) {
    gaps.push({ start: cursor, end: edl.sourceDuration })
  }
  return gaps
}

/** Undo/redo over whole EDL snapshots: cheap to copy, and exact without per-operation inverses. */
export class EditHistory {
  #past: Edl[] = []
  #future: Edl[] = []
  #present: Edl

  constructor(initial: Edl) {
    this.#present = initial
  }

  get current(): Edl {
    return this.#present
  }

  get canUndo(): boolean {
    return this.#past.length > 0
  }

  get canRedo(): boolean {
    return this.#future.length > 0
  }

  /** A no-op change does not create an undo step. */
  commit(next: Edl): Edl {
    if (equals(next, this.#present)) return this.#present
    this.#past.push(this.#present)
    this.#present = next
    this.#future = []
    return next
  }

  undo(): Edl {
    const previous = this.#past.pop()
    if (!previous) return this.#present
    this.#future.push(this.#present)
    this.#present = previous
    return previous
  }

  redo(): Edl {
    const next = this.#future.pop()
    if (!next) return this.#present
    this.#past.push(this.#present)
    this.#present = next
    return next
  }

  reset(edl: Edl): Edl {
    this.#past = []
    this.#future = []
    this.#present = edl
    return edl
  }
}

function equals(a: Edl, b: Edl): boolean {
  if (a.segments.length !== b.segments.length) return false
  // A toggle that cut nothing still changes the EDL and must be undoable.
  const left = autoEdits(a)
  const right = autoEdits(b)
  if (left.filler !== right.filler) return false
  if ((left.silence === null) !== (right.silence === null)) return false
  return a.segments.every((segment, index) => {
    const other = b.segments[index]!
    return (
      Math.abs(segment.start - other.start) < EPSILON &&
      Math.abs(segment.end - other.end) < EPSILON
    )
  })
}
