/**
 * Local ops-flag reader.
 *
 * Upstream resolved these flags remotely at boot. This fork ships no remote flag service, so
 * every flag resolves from `<configDir>/ops-flags.json` when it holds an entry for the key, and
 * otherwise from the flag's own `fallback`. The file is plain operator-editable JSON of the form
 * `{ "<flag key>": { "value": <string | boolean>, "payload": <any> } }`, which makes it the one
 * place a kiosk image can turn a flag on. Nothing here makes a network request.
 *
 * Each flag supplies its own key, fail-direction (`fallback`), and `parse`. The shared part is
 * the plumbing every one of them needs: a single read, an accessor that awaits it rather than
 * racing it to the default, and a fallback that survives an unreadable file or an unrecognised
 * payload. See `cloudFreeRuns.ts` and `coreBetaGrants.ts` for the current callers.
 */
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { inspect } from 'util'
import { configDir } from './paths'
import { readFileSafe, writeFileSafe } from './safe-file'

export type FeatureFlagValue = string | boolean

function persistFilePath(): string {
  return path.join(configDir(), 'ops-flags.json')
}

/** E2E-only: write `E2E_OPS_FLAGS_SEED` into `ops-flags.json` before the first read.
 *
 *  The harness cannot place this file itself. It isolates a run by overriding `HOME`, but
 *  `configDir()` resolves to Electron's `userData` off Linux, and on macOS Application Support
 *  ignores that override — so a file the harness writes under its temp home is never read, and
 *  seeding the real path would write into the developer's own profile. `settings.json` has the
 *  same problem and solves it exactly this way; this mirrors `maybeSeedFromEnv` in
 *  `settings.ts`, including the packaged-build guard and dropping the var so the payload cannot
 *  reach spawned children. Runs at most once per process. */
let e2eSeedApplied = false
function maybeSeedFromEnv(): void {
  if (e2eSeedApplied) return
  e2eSeedApplied = true
  // Env gate first: it is a plain string read, whereas `app` is only a real object inside the
  // Electron runtime. Unit tests import this module outside it, so touching `app` on the
  // common path would make every read test depend on mocking electron.
  if (process.env['E2E'] !== '1') return
  const seed = process.env['E2E_OPS_FLAGS_SEED']
  if (!seed) return
  delete process.env['E2E_OPS_FLAGS_SEED']
  try {
    // Inside the try with everything else: `readPersistedFile`'s whole contract is to degrade
    // to "no entries", and a partially-mocked `app` throwing here would take that down with it.
    // Hard guard: never run in production builds.
    if (app.isPackaged) return
    JSON.parse(seed) // validate before writing
    const filePath = persistFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    // Backup too, so a seeded run cannot be served a stale `.bak` from a previous one.
    writeFileSafe(filePath + '.bak', seed)
    writeFileSafe(filePath, seed)
  } catch (err) {
    console.warn('OpsFlag: failed to apply E2E_OPS_FLAGS_SEED:', (err as Error).message)
  }
}

/** Every entry in `ops-flags.json`, or `{}` for missing / unreadable / non-object /
 *  unparseable content: the file is operator-writable JSON on disk, so every failure mode has
 *  to read as "no entries". */
function readPersistedFile(): Record<string, unknown> {
  maybeSeedFromEnv()
  const outcome = readFileSafe(persistFilePath())
  if (outcome.kind !== 'data') return {}
  try {
    const parsed: unknown = JSON.parse(outcome.data)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

interface PersistedOpsFlagEntry {
  value: FeatureFlagValue
  payload: unknown
}

function readPersistedResult(key: string): PersistedOpsFlagEntry | undefined {
  const entry = readPersistedFile()[key]
  if (!entry || typeof entry !== 'object') return undefined
  const { value, payload } = entry as { value?: unknown; payload?: unknown }
  if (typeof value !== 'string' && typeof value !== 'boolean') return undefined
  return { value, payload }
}

export interface OpsFlag<T> {
  /** Boot-time read. The returned promise is cached so the IPC handler can await it: a
   *  renderer query landing before the read settles sees the resolved value, not the
   *  fallback. Idempotent within a process; never rejects. */
  init(): Promise<void>
  /** Awaits the boot read so renderer queries landing before it settles still get the
   *  resolved value, not the fallback. */
  get(): Promise<T>
  /** @internal — exposed for tests. */
  _resetForTest(): void
}

export function makeOpsFlag<T>(opts: {
  key: string
  /** Value held when `ops-flags.json` has no entry for the key, or one `parse` doesn't
   *  recognise. This is the flag's fail direction. */
  fallback: T
  /** Return `undefined` to retain the fallback. */
  parse: (value: FeatureFlagValue | undefined, payload: unknown) => T | undefined
  /** Enables the `[label] init:` / `[label] init error:` boot logs. Omit for no logging. */
  logLabel?: string
}): OpsFlag<T> {
  const { key, fallback, parse, logLabel } = opts
  let cached: T = fallback
  let initPromise: Promise<void> | null = null

  return {
    init() {
      if (initPromise) return initPromise
      initPromise = (async () => {
        try {
          const stored = readPersistedResult(key)
          const parsed = stored ? parse(stored.value, stored.payload) : parse(undefined, undefined)
          if (parsed !== undefined) cached = parsed
          if (logLabel)
            console.log(
              `[${logLabel}] init: local=`,
              stored ? stored.value : 'none',
              '→ cached=',
              // One line at full depth: the default inspect folds nested payloads to `[Array]`
              // and wraps across lines that a `[label]` grep then misses.
              inspect(cached, { depth: null, breakLength: Infinity, compact: true })
            )
        } catch (err) {
          if (logLabel) console.log(`[${logLabel}] init error:`, err)
        }
      })()
      return initPromise
    },
    async get() {
      if (initPromise) await initPromise
      return cached
    },
    _resetForTest() {
      cached = fallback
      initPromise = null
    }
  }
}
