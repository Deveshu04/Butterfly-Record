import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_BUCKETS_PER_SECOND,
  PEAKS_SCHEMA,
  bucketCount,
  emptyPeaks,
  envelopeFor,
  isPeaks,
  resample,
  type Peaks,
} from '../src/peaks.ts'

function make(pairs: Array<[number, number]>, resolution = 1): Peaks {
  return {
    schema: PEAKS_SCHEMA,
    resolution,
    duration: pairs.length / resolution,
    data: pairs.flat(),
  }
}

function columns(array: Float32Array): number[] {
  // Float32Array narrows values, so round to three decimals. Rounding a negative
  // minimum can yield -0, which deepEqual treats as distinct from 0.
  return [...array].map((value) => {
    const rounded = Math.round(value * 1000) / 1000
    return rounded === 0 ? 0 : rounded
  })
}

/** Asymmetric, with the extremes deliberately not adjacent. */
const four = make([
  [-0.1, 0.1],
  [-0.9, 0.2],
  [-0.2, 0.3],
  [-0.4, 0.8],
])

describe('emptyPeaks', () => {
  it('describes a silent recording of the right length', () => {
    const peaks = emptyPeaks(60)
    assert.equal(peaks.schema, PEAKS_SCHEMA)
    assert.equal(peaks.duration, 60)
    assert.equal(peaks.resolution, DEFAULT_BUCKETS_PER_SECOND)
    assert.equal(bucketCount(peaks), 0)
  })

  it('draws as a flat line rather than as nothing', () => {
    // A recording with no audio still needs a full-length timeline.
    assert.deepEqual(columns(envelopeFor(emptyPeaks(60), 4)), [0, 0, 0, 0])
    assert.deepEqual(columns(resample(emptyPeaks(60), 2)), [0, 0, 0, 0])
  })

  it('never reports a negative or non-finite duration', () => {
    assert.equal(emptyPeaks(-5).duration, 0)
    assert.equal(emptyPeaks(Number.NaN).duration, 0)
    assert.equal(emptyPeaks(Number.POSITIVE_INFINITY).duration, 0)
  })
})

describe('bucketCount', () => {
  it('is one per min,max pair', () => {
    assert.equal(bucketCount(four), 4)
    assert.equal(bucketCount(emptyPeaks(10)), 0)
  })
})

describe('isPeaks', () => {
  it('accepts what generatePeaks produces', () => {
    assert.ok(isPeaks(four))
    assert.ok(isPeaks(emptyPeaks(10)))
  })

  it('rejects anything that is not an envelope', () => {
    assert.equal(isPeaks(null), false)
    assert.equal(isPeaks(undefined), false)
    assert.equal(isPeaks('peaks'), false)
    assert.equal(isPeaks([]), false)
    assert.equal(isPeaks({}), false)
  })

  it('rejects a future or missing schema rather than guessing', () => {
    assert.equal(isPeaks({ ...four, schema: 2 }), false)
    const { schema: _dropped, ...withoutSchema } = four
    assert.equal(isPeaks(withoutSchema), false)
  })

  it('rejects an odd-length data array, which cannot be min,max pairs', () => {
    assert.equal(isPeaks({ ...four, data: [0.1, 0.2, 0.3] }), false)
  })

  it('rejects a resolution that would divide by zero', () => {
    assert.equal(isPeaks({ ...four, resolution: 0 }), false)
    assert.equal(isPeaks({ ...four, resolution: -40 }), false)
  })
})

describe('resample', () => {
  it('returns exactly two entries a column', () => {
    assert.equal(resample(four, 1).length, 2)
    assert.equal(resample(four, 7).length, 14)
    assert.equal(resample(four, 300).length, 600)
  })

  it('is the identity when the width matches the bucket count', () => {
    assert.deepEqual(columns(resample(four, 4)), [-0.1, 0.1, -0.9, 0.2, -0.2, 0.3, -0.4, 0.8])
  })

  it('takes the extreme of each span when reducing, not the average', () => {
    const reduced = columns(resample(four, 2))
    // Buckets 0-1 then 2-3; averaging would hide the loudest moment.
    assert.deepEqual(reduced, [-0.9, 0.2, -0.4, 0.8])
  })

  it('collapses everything into one column at width 1', () => {
    assert.deepEqual(columns(resample(four, 1)), [-0.9, 0.8])
  })

  it('holds each bucket across its columns when stretching', () => {
    const stretched = columns(resample(make([[-1, 1], [-0.5, 0.5]]), 4))
    assert.deepEqual(stretched, [-1, 1, -1, 1, -0.5, 0.5, -0.5, 0.5])
  })

  it('reads only the buckets inside a sub-range', () => {
    // Seconds 1-3 are buckets 1 and 2; bucket 3 (the loudest) must not appear.
    assert.deepEqual(columns(resample(four, 2, 1, 3)), [-0.9, 0.2, -0.2, 0.3])
  })

  it('takes both buckets a column straddles', () => {
    assert.deepEqual(columns(resample(four, 1, 0.5, 1.5)), [-0.9, 0.2])
  })

  it('treats a range given backwards as the same range', () => {
    assert.deepEqual(columns(resample(four, 2, 3, 1)), columns(resample(four, 2, 1, 3)))
  })

  it('clamps a range that overshoots the recording', () => {
    assert.deepEqual(columns(resample(four, 2, -10, 999)), columns(resample(four, 2)))
  })

  it('is silent for a range entirely past the end', () => {
    assert.deepEqual(columns(resample(four, 2, 10, 20)), [0, 0, 0, 0])
  })

  it('is silent for a zero-length range', () => {
    assert.deepEqual(columns(resample(four, 2, 2, 2)), [0, 0, 0, 0])
  })

  it('returns nothing for a width of zero or less', () => {
    // An unmeasured canvas reports zero width.
    assert.equal(resample(four, 0).length, 0)
    assert.equal(resample(four, -5).length, 0)
    assert.equal(resample(four, Number.NaN).length, 0)
  })

  it('floors a fractional width to whole columns', () => {
    assert.equal(resample(four, 2.7).length, 4)
  })

  it('draws the tail of a truncated envelope as silence, not a smear', () => {
    // 8s duration but only four buckets; repeating the last would invent a signal.
    const truncated: Peaks = { ...four, duration: 8 }
    assert.deepEqual(columns(resample(truncated, 4)), [-0.9, 0.2, -0.4, 0.8, 0, 0, 0, 0])
  })

  it('honours a resolution other than one bucket a second', () => {
    const fast = make([[-0.2, 0.2], [-0.6, 0.6], [-0.3, 0.3], [-0.1, 0.1]], 40)
    assert.equal(fast.duration, 0.1)
    assert.deepEqual(columns(resample(fast, 2)), [-0.6, 0.6, -0.3, 0.3])
    // Buckets 2 and 3 live in the second half of the tenth of a second.
    assert.deepEqual(columns(resample(fast, 1, 0.05, 0.1)), [-0.3, 0.3])
  })
})

describe('envelopeFor', () => {
  it('returns one amplitude a column', () => {
    assert.equal(envelopeFor(four, 4).length, 4)
    assert.equal(envelopeFor(four, 0).length, 0)
    assert.equal(envelopeFor(four, -3).length, 0)
  })

  it('is the larger absolute excursion, not half the peak-to-peak span', () => {
    // Bucket 1 runs -0.9..0.2; half the span would draw 0.55 and lose the transient.
    assert.deepEqual(columns(envelopeFor(four, 4)), [0.1, 0.9, 0.3, 0.8])
  })

  it('stays within 0..1 even when the stored envelope does not', () => {
    const hot = make([[-2, 0.1], [-0.1, 3]])
    assert.deepEqual(columns(envelopeFor(hot, 2)), [1, 1])
  })

  it('follows the same reduction as resample', () => {
    assert.deepEqual(columns(envelopeFor(four, 2)), [0.9, 0.8])
    assert.deepEqual(columns(envelopeFor(four, 1)), [0.9])
  })

  it('is zero across a sub-range with no signal in it', () => {
    const gap = make([[-0.5, 0.5], [0, 0], [0, 0], [-0.5, 0.5]])
    assert.deepEqual(columns(envelopeFor(gap, 2, 1, 3)), [0, 0])
  })
})
