import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SPLICE_EPSILON,
  canSpliceCodec,
  outputTimestamp,
  reencodeWindow,
  spliceBitrate,
} from '../src/edit-export.ts'
import { fullEdl, removeRanges, type EditSegment } from '../src/edl.ts'

describe('reencodeWindow', () => {
  const segment = { start: 10, end: 20 }

  it('is null when the keyframe lands on the requested start', () => {
    assert.equal(reencodeWindow(segment, 10, 14), null)
  })

  it('is null when the keyframe is within the epsilon of the start', () => {
    assert.equal(reencodeWindow(segment, 10 - SPLICE_EPSILON / 2, 14), null)
    // A keyframe *after* the start (a snapped EDL re-exported) needs no splice.
    assert.equal(reencodeWindow(segment, 10.5, 14), null)
  })

  it('runs from the requested start to the next keyframe', () => {
    assert.deepEqual(reencodeWindow(segment, 8, 12), { from: 10, to: 12 })
  })

  it('never extends past the segment, even when the next keyframe does', () => {
    assert.deepEqual(reencodeWindow(segment, 8, 25), { from: 10, to: 20 })
  })

  it('covers the whole segment when it sits in the last GOP', () => {
    assert.deepEqual(reencodeWindow(segment, 8, null), { from: 10, to: 20 })
  })

  it('is null with no keyframe at or before the start — the fallback owns that', () => {
    assert.equal(reencodeWindow(segment, null, 12), null)
  })

  it('is null for a window squeezed to nothing', () => {
    assert.equal(reencodeWindow({ start: 10, end: 10 }, 8, null), null)
  })
})

describe('spliceBitrate', () => {
  it('uses the measured bitrate, rounded to whole bits', () => {
    assert.equal(spliceBitrate(2_500_000.4), 2_500_000)
  })

  it('falls back when the measurement is missing or unusable', () => {
    const fallback = spliceBitrate(null)
    assert.ok(fallback >= 1_000_000, 'fallback must not starve the boundary GOP')
    assert.equal(spliceBitrate(undefined), fallback)
    assert.equal(spliceBitrate(0), fallback)
    assert.equal(spliceBitrate(-5), fallback)
    assert.equal(spliceBitrate(Number.NaN), fallback)
    assert.equal(spliceBitrate(Number.POSITIVE_INFINITY), fallback)
  })
})

describe('canSpliceCodec', () => {
  it('allows exactly the codecs whose frames carry their own headers', () => {
    assert.equal(canSpliceCodec('vp8'), true)
    assert.equal(canSpliceCodec('vp9'), true)
  })

  it('refuses codecs with out-of-band parameter sets, and the unknown', () => {
    for (const codec of ['avc', 'hevc', 'av1', 'prores', null, '']) {
      assert.equal(canSpliceCodec(codec), false, `must not splice ${JSON.stringify(codec)}`)
    }
  })
})

describe('outputTimestamp', () => {
  const segment = { start: 10, end: 20 }

  it('places a packet by its offset into the segment', () => {
    // Segment at source 10 placed at output 3: a packet at 12.5 lands at 5.5.
    assert.equal(outputTimestamp(12.5, segment, 3), 5.5)
  })

  it('puts packets from before the segment start on its output start', () => {
    assert.equal(outputTimestamp(9.98, segment, 3), 3)
    assert.equal(outputTimestamp(8, segment, 0), 0)
  })
})

interface Packet {
  timestamp: number
  key: boolean
}

/** The muxer's rule: nothing may be older than the last GOP before the latest key packet. */
function assertMuxable(packets: Packet[], label: string): void {
  let max = -Infinity
  let floor = -Infinity
  for (const packet of packets) {
    assert.ok(packet.timestamp >= 0, `${label}: negative timestamp ${packet.timestamp}`)
    if (packet.key) floor = max
    assert.ok(
      packet.timestamp >= floor,
      `${label}: ${packet.timestamp} is older than the previous GOP, which reached ${floor}`,
    )
    max = Math.max(max, packet.timestamp)
  }
}

describe('exported packet timing', () => {
  // A 10 s source: 30 fps video with irregular keyframes, 20 ms audio packets.
  const keyFrames = new Set([0, 101, 167, 240])
  const video: Packet[] = Array.from({ length: 300 }, (_, i) => ({
    timestamp: i / 30,
    key: keyFrames.has(i),
  }))
  const audio: Packet[] = Array.from({ length: 500 }, (_, i) => ({ timestamp: i * 0.02, key: true }))

  const atOrBefore = (packets: Packet[], time: number) =>
    packets.findLastIndex((packet) => packet.timestamp <= time)
  const keyAtOrBefore = (time: number) =>
    video.findLastIndex((packet) => packet.key && packet.timestamp <= time)
  const packetsFrom = (packets: Packet[], from: number, end: number) => {
    const out: Packet[] = []
    for (let i = Math.max(0, from); i < packets.length && packets[i]!.timestamp < end; i++) {
      out.push(packets[i]!)
    }
    return out
  }

  /** The packets each path writes for a segment, still on the source timeline. */
  function videoPackets(segment: EditSegment, splice: boolean): Packet[] {
    const key = keyAtOrBefore(segment.start)
    const nextKey = video.findIndex((packet, i) => i > key && packet.key)
    const next = nextKey === -1 ? null : video[nextKey]!.timestamp
    const window = reencodeWindow(segment, video[key]!.timestamp, next)
    if (!splice || !window) return packetsFrom(video, key, segment.end)
    // The re-encoded head starts at the frame showing at `from` and is keyframe-led.
    const head = packetsFrom(video, atOrBefore(video, window.from), window.to).map((packet, i) => ({
      timestamp: packet.timestamp,
      key: i === 0,
    }))
    if (next === null || next >= segment.end) return head
    return [...head, ...packetsFrom(video, nextKey, segment.end)]
  }

  function exported(segments: EditSegment[], splice: boolean) {
    const out = { video: [] as Packet[], audio: [] as Packet[] }
    let cursor = 0
    for (const segment of segments) {
      const place = (packet: Packet) => ({
        timestamp: outputTimestamp(packet.timestamp, segment, cursor),
        key: packet.key,
      })
      out.video.push(...videoPackets(segment, splice).map(place))
      out.audio.push(...packetsFrom(audio, atOrBefore(audio, segment.start), segment.end).map(place))
      cursor += segment.end - segment.start
    }
    return out
  }

  let seed = 7
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const cutLists: EditSegment[][] = [
    [{ start: 1, end: 2 }],
    [{ start: 2.31, end: 3.77 }],
    [
      { start: 1, end: 2 },
      { start: 2.31, end: 3.77 },
      { start: 4.2, end: 5.05 },
      { start: 5.5, end: 6.6 },
    ],
  ]
  for (let n = 0; n < 20; n++) {
    const cuts: EditSegment[] = []
    for (let t = 0.2 + random(); t < 9.5; t += 0.3 + random()) {
      const end = t + 0.05 + random() * 0.6
      cuts.push({ start: t, end })
      t = end
    }
    cutLists.push(cuts)
  }

  it('never writes a packet the muxer would reject, on any path', () => {
    for (const [n, cuts] of cutLists.entries()) {
      const { segments } = removeRanges(fullEdl(10), cuts)
      for (const splice of [true, false]) {
        const { video: v, audio: a } = exported(segments, splice)
        assertMuxable(v, `cut list ${n}, ${splice ? 'spliced' : 'copy-only'} video`)
        assertMuxable(a, `cut list ${n} audio`)
      }
    }
  })

  it('keeps every segment inside its own slot of the output', () => {
    const { segments } = removeRanges(fullEdl(10), cutLists[2]!)
    let cursor = 0
    for (const segment of segments) {
      const end = cursor + (segment.end - segment.start)
      for (const packet of videoPackets(segment, false)) {
        const at = outputTimestamp(packet.timestamp, segment, cursor)
        assert.ok(at >= cursor && at <= end, `${at} is outside ${cursor}..${end}`)
      }
      cursor = end
    }
  })
})
