import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ULID_LENGTH, isUlid, ulid, ulidTime } from '../src/ids.ts'
import { audioBitrateFor, bitrateFor, secondsRemaining } from '../src/bitrate.ts'
import { SerialQueue, Stopwatch } from '../src/encoder.ts'
import { safeFilename, safeFilenameWithExtension } from '../src/filenames.ts'
import {
  ABANDONED_SESSION_AGE_MS,
  InsufficientSpaceError,
  TRASH_RETENTION_DAYS,
  daysUntilPurge,
  formatBytes,
  formatDuration,
  isAbandonedSession,
  sessionState,
} from '../src/library.ts'
import {
  MANIFEST_SCHEMA,
  createManifest,
  defaultTitle,
  isTrashed,
  normalizeManifest,
  type RecordingManifest,
} from '../src/manifest.ts'

describe('ulid', () => {
  it('is the documented length and alphabet', () => {
    const id = ulid()
    assert.equal(id.length, ULID_LENGTH)
    assert.ok(isUlid(id))
  })

  it('round-trips the timestamp', () => {
    const now = 1_785_600_000_000
    assert.equal(ulidTime(ulid(now)), now)
  })

  it('sorts lexicographically by creation time', () => {
    const early = ulid(1_700_000_000_000)
    const late = ulid(1_800_000_000_000)
    assert.ok(early < late, `${early} should sort before ${late}`)
  })

  it('does not collide across a large batch', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => ulid(1_785_600_000_000)))
    assert.equal(ids.size, 10_000)
  })

  it('rejects timestamps it cannot encode', () => {
    assert.throws(() => ulid(-1), RangeError)
    assert.throws(() => ulid(2 ** 48), RangeError)
  })

  it('rejects non-ULIDs', () => {
    assert.equal(isUlid('nope'), false)
    // I, L, O and U are absent from Crockford base32.
    assert.equal(isUlid('I'.repeat(ULID_LENGTH)), false)
  })
})

describe('bitrateFor', () => {
  it('matches the reference table exactly', () => {
    assert.equal(bitrateFor({ width: 1280, height: 720, frameRate: 30 }), 4_000_000)
    assert.equal(bitrateFor({ width: 1920, height: 1080, frameRate: 30 }), 10_000_000)
    assert.equal(bitrateFor({ width: 1920, height: 1080, frameRate: 60 }), 15_000_000)
    assert.equal(bitrateFor({ width: 2560, height: 1440, frameRate: 30 }), 18_000_000)
    assert.equal(bitrateFor({ width: 3840, height: 2160, frameRate: 30 }), 40_000_000)
    assert.equal(bitrateFor({ width: 3840, height: 2160, frameRate: 60 }), 60_000_000)
  })

  it('interpolates off-table sizes without going out of range', () => {
    const odd = bitrateFor({ width: 1600, height: 900, frameRate: 30 })
    assert.ok(Number.isFinite(odd))
    assert.ok(odd > 4_000_000 && odd < 10_000_000, `got ${odd}`)
  })

  it('never returns a degenerate value for a tiny or absurd capture', () => {
    assert.ok(bitrateFor({ width: 160, height: 120, frameRate: 5 }) >= 1_000_000)
    assert.ok(bitrateFor({ width: 15360, height: 8640, frameRate: 120 }) <= 80_000_000)
  })

  it('scales monotonically with resolution', () => {
    const small = bitrateFor({ width: 640, height: 360, frameRate: 30 })
    const large = bitrateFor({ width: 2560, height: 1440, frameRate: 30 })
    assert.ok(small < large)
  })
})

describe('secondsRemaining', () => {
  it('converts a byte budget into recording time', () => {
    // 10 Mbps video + 128 kbps audio = 1_266_000 bytes/sec.
    const seconds = secondsRemaining(1_266_000 * 60, 10_000_000, audioBitrateFor(2))
    assert.ok(Math.abs(seconds - 60) < 0.5, `got ${seconds}`)
  })

  it('is zero when the disk is full, not negative', () => {
    assert.equal(secondsRemaining(0, 10_000_000, 128_000), 0)
  })
})

describe('Stopwatch', () => {
  it('excludes paused time', async () => {
    // Bounds are measured around each call, so a slow or busy machine widens them
    // instead of failing the test.
    const watch = new Stopwatch()
    const beforeStart = performance.now()
    watch.start()
    const afterStart = performance.now()
    await sleep(40)
    const beforePause = performance.now()
    watch.pause()
    const afterPause = performance.now()

    const atPause = watch.elapsed
    await sleep(60)
    assert.equal(watch.elapsed, atPause, 'the clock moved while paused')

    const beforeResume = performance.now()
    watch.resume()
    const afterResume = performance.now()
    await sleep(40)
    const beforeRead = performance.now()
    const total = watch.elapsed
    const afterRead = performance.now()

    const slack = 1e-6
    const firstMin = (beforePause - afterStart) / 1000
    const firstMax = (afterPause - beforeStart) / 1000
    assert.ok(atPause >= firstMin - slack && atPause <= firstMax + slack, `got ${atPause}`)

    const totalMin = firstMin + (beforeRead - afterResume) / 1000
    const totalMax = firstMax + (afterRead - beforeResume) / 1000
    assert.ok(total >= totalMin - slack, `resume did not restart the clock: ${total} < ${totalMin}`)
    assert.ok(total <= totalMax + slack, `counted paused time: ${total} > ${totalMax}`)
  })

  it('is idempotent on repeated pause and resume', () => {
    const watch = new Stopwatch()
    watch.start()
    watch.pause()
    watch.pause()
    const held = watch.elapsed
    watch.resume()
    watch.resume()
    assert.ok(watch.elapsed >= held)
  })
})

describe('SerialQueue', () => {
  it('preserves order even when tasks finish out of order', async () => {
    const queue = new SerialQueue()
    const done: number[] = []
    const tasks = [30, 5, 20, 1].map((delay, index) =>
      queue.run(async () => {
        await sleep(delay)
        done.push(index)
      }),
    )
    await Promise.all(tasks)
    assert.deepEqual(done, [0, 1, 2, 3])
  })

  it('keeps running after a task throws', async () => {
    const queue = new SerialQueue()
    const boom = queue.run(async () => {
      throw new Error('boom')
    })
    await assert.rejects(boom, /boom/)

    const after = await queue.run(async () => 'still here')
    assert.equal(after, 'still here')
  })

  it('drain waits for everything queued', async () => {
    const queue = new SerialQueue()
    let finished = false
    void queue.run(async () => {
      await sleep(30)
      finished = true
    })
    await queue.drain()
    assert.equal(finished, true)
  })
})

describe('manifest', () => {
  it('starts in the recording state with no duration', () => {
    const manifest = createManifest({
      id: ulid(),
      producer: { app: 'extension', version: '0.1.0', os: 'test' },
      video: {
        codec: 'vp9',
        container: 'webm',
        width: 1920,
        height: 1080,
        frameRate: 30,
        bitrate: 10_000_000,
        surface: 'tab',
        sourceLabel: 'Example',
      },
      audio: { codec: 'opus', sampleRate: 48000, channels: 2, tracks: [] },
      camera: null,
    })

    assert.equal(manifest.status, 'recording')
    assert.equal(manifest.duration, null)
    assert.equal(manifest.sha256, null)
    assert.equal(manifest.schema, MANIFEST_SCHEMA)
    assert.equal(manifest.deletedAt, null)
    assert.equal(manifest.posterTime, null)
    assert.ok(manifest.title.startsWith('Recording '))
  })

  it('names an untitled recording after its date and time', () => {
    const title = defaultTitle(new Date('2026-08-02T10:45:00Z'))
    assert.ok(title.startsWith('Recording '))
    assert.ok(title.length > 'Recording '.length)
  })

  it('fills in fields a schema-1 file on disk predates', () => {
    // A schema-1 manifest.json has no deletedAt or posterTime; they must not stay undefined.
    const old = {
      id: ulid(),
      schema: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      producer: { app: 'extension', version: '0.0.1', os: 'test' },
      status: 'ready',
      duration: 12,
      video: {
        codec: 'vp9',
        container: 'webm',
        width: 1920,
        height: 1080,
        frameRate: 30,
        bitrate: 10_000_000,
        surface: 'tab',
        sourceLabel: 'Example',
      },
      audio: { codec: 'opus', sampleRate: 48000, channels: 2, tracks: [] },
      camera: null,
      bytes: 1024,
      sha256: null,
      title: 'Old recording',
    } as unknown as RecordingManifest

    const upgraded = normalizeManifest(old)
    assert.equal(upgraded.schema, MANIFEST_SCHEMA)
    assert.equal(upgraded.deletedAt, null)
    assert.equal(upgraded.posterTime, null)
    assert.equal(upgraded.folderId, null)
    assert.equal(upgraded.description, '')
    assert.deepEqual(upgraded.pauses, [])
    assert.equal(upgraded.share, null)
    assert.equal(isTrashed(upgraded), false)
    assert.equal(upgraded.title, 'Old recording')
    assert.equal(upgraded.duration, 12)
  })

  it('reports a trashed recording as trashed', () => {
    const manifest = createManifest({
      id: ulid(),
      producer: { app: 'extension', version: '0.1.0', os: 'test' },
      video: {
        codec: 'vp9',
        container: 'webm',
        width: 1280,
        height: 720,
        frameRate: 30,
        bitrate: 4_000_000,
        surface: 'tab',
        sourceLabel: 'Example',
      },
      audio: { codec: 'opus', sampleRate: 48000, channels: 2, tracks: [] },
      camera: null,
    })
    assert.equal(isTrashed(manifest), false)
    assert.equal(isTrashed({ ...manifest, deletedAt: '2026-08-01T00:00:00.000Z' }), true)
  })
})

describe('daysUntilPurge', () => {
  const at = (deletedAt: string | null) =>
    ({ deletedAt }) as unknown as RecordingManifest

  const day = 86_400_000
  const now = Date.parse('2026-08-31T00:00:00.000Z')

  it('counts down from the retention window', () => {
    assert.equal(daysUntilPurge(at(new Date(now).toISOString()), now), TRASH_RETENTION_DAYS)
    assert.equal(daysUntilPurge(at(new Date(now - 10 * day).toISOString()), now), 20)
  })

  it('reaches zero exactly at the window, and never goes negative', () => {
    const due = new Date(now - TRASH_RETENTION_DAYS * day).toISOString()
    assert.equal(daysUntilPurge(at(due), now), 0)
    assert.equal(daysUntilPurge(at(new Date(now - 400 * day).toISOString()), now), 0)
  })

  it('treats a live or unparseable recording as having the full window', () => {
    assert.equal(daysUntilPurge(at(null), now), TRASH_RETENTION_DAYS)
    assert.equal(daysUntilPurge(at('not a date'), now), TRASH_RETENTION_DAYS)
  })
})

describe('sessionState', () => {
  it('treats a non-empty source.webm as finished once the manifest says so', () => {
    assert.equal(sessionState({ source: 4096, part: null }), 'ready')
    assert.equal(sessionState({ source: 4096, part: null }, 'recording'), 'ready')
    // A part file that failed to delete after a verified finalize.
    assert.equal(sessionState({ source: 4096, part: 8192 }, 'ready'), 'ready')
  })

  it('does not let a source.webm from an unfinished finalize hide the raw capture', () => {
    // What a failed remux used to commit: a truncated output next to the full capture.
    for (const status of ['recording', 'finalizing', 'orphaned'] as const) {
      assert.equal(sessionState({ source: 1_200_000, part: 300_000_000 }, status), 'recoverable')
    }
  })

  it('does not let an empty or missing source.webm hide the raw capture', () => {
    // What an interrupted finalize used to leave: a 0-byte output next to the full capture.
    assert.equal(sessionState({ source: 0, part: 8192 }), 'recoverable')
    assert.equal(sessionState({ source: null, part: 8192 }), 'recoverable')
  })

  it('reports a session with no usable media as empty', () => {
    assert.equal(sessionState({ source: null, part: null }), 'empty')
    assert.equal(sessionState({ source: 0, part: 0 }), 'empty')
    assert.equal(sessionState({ source: null, part: 0 }), 'empty')
  })
})

describe('isAbandonedSession', () => {
  const created = Date.parse('2026-08-01T00:00:00.000Z')
  const id = ulid(created)
  const empty = { source: null, part: null }

  it('sweeps an empty session only once it is older than the cutoff', () => {
    assert.equal(isAbandonedSession(id, empty, created + 60_000), false)
    assert.equal(isAbandonedSession(id, empty, created + ABANDONED_SESSION_AGE_MS), false)
    assert.equal(isAbandonedSession(id, empty, created + ABANDONED_SESSION_AGE_MS + 1), true)
    const zeroed = { source: 0, part: 0 }
    assert.equal(isAbandonedSession(id, zeroed, created + 2 * ABANDONED_SESSION_AGE_MS), true)
  })

  it('never sweeps a session that still holds media', () => {
    const later = created + 30 * ABANDONED_SESSION_AGE_MS
    assert.equal(isAbandonedSession(id, { source: null, part: 1 }, later), false)
    assert.equal(isAbandonedSession(id, { source: 1, part: null }, later), false)
  })

  it('leaves folders it did not name alone', () => {
    assert.equal(isAbandonedSession('not-a-session', empty, Date.now()), false)
  })
})

describe('InsufficientSpaceError', () => {
  it('carries both sizes and says the recording was kept', () => {
    const error = new InsufficientSpaceError(3 * 1024 ** 3, 512 * 1024 ** 2)
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'InsufficientSpaceError')
    assert.equal(error.required, 3 * 1024 ** 3)
    assert.equal(error.available, 512 * 1024 ** 2)
    assert.match(error.message, /3\.0 GB/)
    assert.match(error.message, /512 MB/)
    assert.match(error.message, /kept/)
  })
})

describe('safeFilename', () => {
  it('strips every character Windows rejects', () => {
    assert.doesNotMatch(safeFilename('a\\b/c:d*e?f"g<h>i|j'), /[\\/:*?"<>|]/)
  })

  it('survives the colon that every locale puts in a default title', () => {
    const name = safeFilename(defaultTitle(new Date('2026-08-02T10:45:00Z')))
    assert.doesNotMatch(name, /[\\/:*?"<>|]/)
    assert.ok(name.startsWith('Recording '))
  })

  it('never returns an empty name', () => {
    assert.equal(safeFilename(''), 'Recording')
    assert.equal(safeFilename('   '), 'Recording')
    assert.equal(safeFilename('///'), 'Recording')
    assert.equal(safeFilename('', 'Untitled'), 'Untitled')
  })

  it('escapes Windows reserved device names', () => {
    // "CON.webm" cannot be created on Windows at all.
    assert.equal(safeFilename('CON'), 'CON-recording')
    assert.equal(safeFilename('nul'), 'nul-recording')
    assert.equal(safeFilename('COM4'), 'COM4-recording')
    // Only reserved as the whole stem.
    assert.equal(safeFilename('CONTROL'), 'CONTROL')
  })

  it('does not end in a dot or a space', () => {
    assert.equal(safeFilename('demo.'), 'demo')
    assert.equal(safeFilename('demo   '), 'demo')
    assert.equal(safeFilename('demo. . '), 'demo')
  })

  it('removes control characters', () => {
    const withControls = `demo${String.fromCharCode(0)}${String.fromCharCode(31)}x`
    assert.equal(safeFilename(withControls), 'demox')
  })

  it('truncates without leaving a trailing space', () => {
    const name = safeFilename(`${'a'.repeat(119)} tail`)
    assert.ok(name.length <= 120)
    assert.doesNotMatch(name, /[. ]$/)
  })

  it('does not split a surrogate pair when truncating', () => {
    const name = safeFilename(`${'a'.repeat(119)}\u{1F600} tail`)
    assert.equal(name, 'a'.repeat(119))
    // A lone surrogate would be escaped as \ud83d, which JSON IPC parsers reject.
    assert.doesNotMatch(JSON.stringify(name), /\\ud[89ab]/i)
    assert.equal(safeFilename(`${'a'.repeat(118)} \u{1F600}`), 'a'.repeat(118))
    assert.equal(safeFilename(`${'a'.repeat(118)}\u{1F600}`), `${'a'.repeat(118)}\u{1F600}`)
  })

  it('appends the extension exactly once', () => {
    assert.equal(safeFilenameWithExtension('Sprint demo', 'webm'), 'Sprint demo.webm')
    assert.equal(safeFilenameWithExtension('Sprint demo', '.webm'), 'Sprint demo.webm')
  })
})

describe('formatBytes', () => {
  it('uses binary units, the way disks report them', () => {
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(999), '999 B')
    assert.equal(formatBytes(1024), '1.0 KB')
    assert.equal(formatBytes(1024 * 1024), '1.0 MB')
    assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB')
  })

  it('drops the decimal once the number is big enough not to need it', () => {
    assert.equal(formatBytes(1024 * 1024 * 9.5), '9.5 MB')
    assert.equal(formatBytes(1024 * 1024 * 214), '214 MB')
  })

  it('stops at terabytes rather than inventing a unit', () => {
    assert.match(formatBytes(1024 ** 5), /TB$/)
  })
})

describe('formatDuration', () => {
  it('omits the hour until there is one', () => {
    assert.equal(formatDuration(0), '0:00')
    assert.equal(formatDuration(9), '0:09')
    assert.equal(formatDuration(252), '4:12')
    assert.equal(formatDuration(3600), '1:00:00')
    assert.equal(formatDuration(3852), '1:04:12')
  })

  it('renders a dash for a duration we do not have', () => {
    // What an unfinalized WebM reports before the remux pass.
    assert.equal(formatDuration(null), '—')
    assert.equal(formatDuration(Infinity), '—')
    assert.equal(formatDuration(NaN), '—')
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
