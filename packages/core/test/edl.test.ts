import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EditHistory,
  cutCount,
  fullEdl,
  isUnedited,
  normalize,
  outputDuration,
  outputToSource,
  removeRange,
  removedRanges,
  sourceToOutput,
  splitAt,
  trimSegment,
  type Edl,
} from '../src/edl.ts'

const edl = (sourceDuration: number, segments: Array<[number, number]>): Edl => ({
  schema: 1,
  sourceDuration,
  segments: segments.map(([start, end]) => ({ start, end })),
})

const shape = (value: Edl): Array<[number, number]> =>
  value.segments.map((segment) => [segment.start, segment.end])

describe('fullEdl', () => {
  it('keeps the whole source', () => {
    const value = fullEdl(100)
    assert.deepEqual(shape(value), [[0, 100]])
    assert.equal(outputDuration(value), 100)
    assert.equal(isUnedited(value), true)
    assert.equal(cutCount(value), 0)
  })

  it('has no segments for an empty recording', () => {
    assert.deepEqual(shape(fullEdl(0)), [])
  })
})

describe('removeRange', () => {
  it('cuts a hole in the middle', () => {
    const value = removeRange(fullEdl(100), 30, 40)
    assert.deepEqual(shape(value), [
      [0, 30],
      [40, 100],
    ])
    assert.equal(outputDuration(value), 90)
  })

  it('trims the head and the tail', () => {
    assert.deepEqual(shape(removeRange(fullEdl(100), 0, 10)), [[10, 100]])
    assert.deepEqual(shape(removeRange(fullEdl(100), 90, 100)), [[0, 90]])
  })

  it('spans several segments at once', () => {
    const start = edl(100, [
      [0, 20],
      [40, 60],
      [80, 100],
    ])
    assert.deepEqual(shape(removeRange(start, 10, 90)), [
      [0, 10],
      [90, 100],
    ])
  })

  it('accepts reversed arguments, which a right-to-left drag produces', () => {
    assert.deepEqual(shape(removeRange(fullEdl(100), 40, 30)), [
      [0, 30],
      [40, 100],
    ])
  })

  it('ignores a zero-width removal', () => {
    assert.deepEqual(shape(removeRange(fullEdl(100), 30, 30)), [[0, 100]])
  })

  it('can remove everything', () => {
    assert.deepEqual(shape(removeRange(fullEdl(100), 0, 100)), [])
    assert.equal(outputDuration(removeRange(fullEdl(100), 0, 100)), 0)
  })
})

describe('splitAt', () => {
  it('creates a boundary without changing the output', () => {
    const value = splitAt(fullEdl(100), 50)
    assert.deepEqual(shape(value), [
      [0, 50],
      [50, 100],
    ])
    assert.equal(outputDuration(value), 100)
    assert.equal(cutCount(value), 0)
  })

  it('does nothing at a segment edge or outside any segment', () => {
    assert.deepEqual(shape(splitAt(fullEdl(100), 0)), [[0, 100]])
    assert.deepEqual(shape(splitAt(fullEdl(100), 100)), [[0, 100]])
    const gapped = edl(100, [
      [0, 20],
      [40, 60],
    ])
    assert.deepEqual(shape(splitAt(gapped, 30)), [
      [0, 20],
      [40, 60],
    ])
  })

  it('survives being split repeatedly', () => {
    let value = fullEdl(100)
    for (const at of [25, 50, 75]) value = splitAt(value, at)
    assert.equal(value.segments.length, 4)
    assert.equal(outputDuration(value), 100)
  })
})

describe('normalize', () => {
  it('merges overlaps and orders segments', () => {
    const messy = edl(100, [
      [50, 70],
      [10, 30],
      [25, 55],
    ])
    assert.deepEqual(shape(normalize(messy)), [[10, 70]])
  })

  it('drops empty segments and clamps out-of-range ones', () => {
    const messy = edl(100, [
      [10, 10],
      [-20, 30],
      [90, 200],
    ])
    assert.deepEqual(shape(normalize(messy)), [
      [0, 30],
      [90, 100],
    ])
  })
})

describe('trimSegment', () => {
  it('moves an edge', () => {
    const value = trimSegment(fullEdl(100), 0, 'start', 15)
    assert.deepEqual(shape(value), [[15, 100]])
  })

  it('will not let an edge cross its own segment', () => {
    const collapsed = trimSegment(fullEdl(100), 0, 'start', 150)
    assert.ok(collapsed.segments[0]!.start < collapsed.segments[0]!.end)
  })

  it('will not let an edge cross a neighbour', () => {
    const two = edl(100, [
      [0, 40],
      [60, 100],
    ])
    assert.equal(trimSegment(two, 1, 'start', 10).segments[1]!.start, 40)
    assert.equal(trimSegment(two, 0, 'end', 90).segments[0]!.end, 60)
  })

  it('ignores an index that does not exist', () => {
    assert.deepEqual(shape(trimSegment(fullEdl(100), 7, 'start', 10)), [[0, 100]])
  })
})

describe('time mapping', () => {
  const cut = removeRange(fullEdl(100), 30, 40) // keeps 0-30 and 40-100

  it('maps source to output across a cut', () => {
    assert.equal(sourceToOutput(cut, 0), 0)
    assert.equal(sourceToOutput(cut, 20), 20)
    assert.equal(sourceToOutput(cut, 40), 30)
    assert.equal(sourceToOutput(cut, 50), 40)
    assert.equal(sourceToOutput(cut, 100), 90)
  })

  it('returns null for a moment that was cut out', () => {
    assert.equal(sourceToOutput(cut, 35), null)
  })

  it('maps output back to source', () => {
    assert.equal(outputToSource(cut, 0), 0)
    assert.equal(outputToSource(cut, 20), 20)
    assert.equal(outputToSource(cut, 40), 50)
    assert.equal(outputToSource(cut, 90), 100)
  })

  it('resolves a boundary forwards, so the playhead crosses the cut', () => {
    // Output 30 ends [0,30] and starts [40,100]; resolving backwards would leave
    // the playhead stuck on the frame before the cut.
    assert.equal(outputToSource(cut, 30), 40)
  })

  it('round-trips every kept moment', () => {
    for (const source of [0, 5, 29, 40, 55, 99]) {
      const output = sourceToOutput(cut, source)
      assert.notEqual(output, null)
      assert.ok(Math.abs(outputToSource(cut, output!) - source) < 1e-6, `at ${source}`)
    }
  })

  it('clamps past the end rather than running off', () => {
    assert.equal(outputToSource(cut, 999), 100)
  })
})

describe('removedRanges', () => {
  it('reports the gaps the timeline greys out', () => {
    const value = removeRange(removeRange(fullEdl(100), 10, 20), 60, 70)
    assert.deepEqual(
      removedRanges(value).map((r) => [r.start, r.end]),
      [
        [10, 20],
        [60, 70],
      ],
    )
  })

  it('includes a trimmed head and tail', () => {
    const value = edl(100, [[10, 90]])
    assert.deepEqual(
      removedRanges(value).map((r) => [r.start, r.end]),
      [
        [0, 10],
        [90, 100],
      ],
    )
  })

  it('reports nothing for an untouched recording', () => {
    assert.deepEqual(removedRanges(fullEdl(100)), [])
  })
})

describe('cutCount', () => {
  it('counts head, middle and tail cuts', () => {
    assert.equal(cutCount(fullEdl(100)), 0)
    assert.equal(cutCount(removeRange(fullEdl(100), 0, 10)), 1)
    assert.equal(cutCount(removeRange(fullEdl(100), 30, 40)), 1)
    assert.equal(cutCount(removeRange(removeRange(fullEdl(100), 0, 5), 30, 40)), 2)
  })
})

describe('EditHistory', () => {
  it('undoes and redoes exactly', () => {
    const history = new EditHistory(fullEdl(100))
    history.commit(removeRange(history.current, 30, 40))
    history.commit(removeRange(history.current, 70, 80))
    assert.equal(history.current.segments.length, 3)

    history.undo()
    assert.equal(history.current.segments.length, 2)
    history.undo()
    assert.deepEqual(shape(history.current), [[0, 100]])
    assert.equal(history.canUndo, false)

    history.redo()
    assert.equal(history.current.segments.length, 2)
  })

  it('does not record a change that changes nothing', () => {
    const history = new EditHistory(fullEdl(100))
    history.commit(removeRange(history.current, 50, 50))
    assert.equal(history.canUndo, false)
  })

  it('drops the redo stack once a new edit lands', () => {
    const history = new EditHistory(fullEdl(100))
    history.commit(removeRange(history.current, 30, 40))
    history.undo()
    assert.equal(history.canRedo, true)

    history.commit(removeRange(history.current, 10, 20))
    assert.equal(history.canRedo, false)
  })

  it('is a no-op at either end of the stack', () => {
    const history = new EditHistory(fullEdl(100))
    assert.deepEqual(shape(history.undo()), [[0, 100]])
    assert.deepEqual(shape(history.redo()), [[0, 100]])
  })

  it('reset clears both directions', () => {
    const history = new EditHistory(fullEdl(100))
    history.commit(removeRange(history.current, 30, 40))
    history.reset(fullEdl(100))
    assert.equal(history.canUndo, false)
    assert.equal(history.canRedo, false)
  })
})
