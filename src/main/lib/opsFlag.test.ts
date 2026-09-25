// The plumbing every ops flag shares: one read of the local `ops-flags.json`, an accessor
// that awaits it rather than racing it to the default, and a fallback that survives a missing
// file, an unreadable file, and a payload `parse` doesn't recognise. Per-flag
// key/fail-direction/parsing is covered by that flag's own spec (see `cloudFreeRuns.test.ts`).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// `configDir()` reads XDG_CONFIG_HOME on Linux and electron's userData elsewhere; mocking the
// module directly pins `ops-flags.json` to a temp dir.
let testConfigDir = ''
vi.mock('./paths', () => ({
  configDir: () => testConfigDir
}))

import { makeOpsFlag } from './opsFlag'

/** A three-value flag, so "unrecognised payload" is distinguishable from "valid value". */
function makeTestFlag() {
  return makeOpsFlag<'normal' | 'degraded' | 'disabled'>({
    key: 'test-flag',
    fallback: 'normal',
    parse: (value) =>
      value === 'degraded' || value === 'disabled' || value === 'normal' ? value : undefined
  })
}

function flagFile(): string {
  return path.join(testConfigDir, 'ops-flags.json')
}

function writeFlags(entries: unknown): void {
  fs.writeFileSync(flagFile(), JSON.stringify(entries))
}

beforeEach(() => {
  // Every test: an empty `configDir()` would resolve `ops-flags.json` relative to cwd and drop
  // a file in the repo root.
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-flag-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(testConfigDir, { recursive: true, force: true })
})

describe('makeOpsFlag', () => {
  it('resolves a recognised value from ops-flags.json', async () => {
    writeFlags({ 'test-flag': { value: 'disabled' } })
    const flag = makeTestFlag()
    await flag.init()
    expect(await flag.get()).toBe('disabled')
  })

  it.each([['garbage'], [true]])('keeps the fallback for %s', async (value) => {
    // `parse` returning undefined is how an unrecognised payload is told apart from a
    // legitimate value — it must not overwrite the fail direction.
    writeFlags({ 'test-flag': { value } })
    const flag = makeTestFlag()
    await flag.init()
    expect(await flag.get()).toBe('normal')
  })

  it('returns the fallback when the file is missing', async () => {
    const flag = makeTestFlag()
    await flag.init()
    expect(await flag.get()).toBe('normal')
  })

  it.each([
    ['corrupt JSON', '{not json'],
    ['a non-object', '[1, 2, 3]'],
    ['a non-scalar value', JSON.stringify({ 'test-flag': { value: { nested: true } } })]
  ])('returns the fallback when the file holds %s', async (_label, contents) => {
    fs.writeFileSync(flagFile(), contents)
    const flag = makeTestFlag()
    await flag.init()
    expect(await flag.get()).toBe('normal')
  })

  it('ignores an entry for a different key', async () => {
    writeFlags({ 'other-flag': { value: 'disabled' } })
    const flag = makeTestFlag()
    await flag.init()
    expect(await flag.get()).toBe('normal')
  })

  it('hands the stored payload to parse alongside the value', async () => {
    writeFlags({ 'payload-flag': { value: true, payload: { level: 3 } } })
    const parse = vi.fn((_value: unknown, payload: unknown) => payload as { level: number })
    const flag = makeOpsFlag<{ level: number } | null>({
      key: 'payload-flag',
      fallback: null,
      parse
    })
    await flag.init()
    expect(parse).toHaveBeenCalledWith(true, { level: 3 })
    expect(await flag.get()).toEqual({ level: 3 })
  })

  it('asks parse about an absent entry, so a flag can derive its own default', async () => {
    const parse = vi.fn(() => 'degraded' as const)
    const flag = makeOpsFlag<'normal' | 'degraded'>({ key: 'test-flag', fallback: 'normal', parse })
    await flag.init()
    expect(parse).toHaveBeenCalledWith(undefined, undefined)
    expect(await flag.get()).toBe('degraded')
  })

  it('awaits the boot read rather than returning the fallback', async () => {
    writeFlags({ 'test-flag': { value: 'degraded' } })
    const flag = makeTestFlag()
    const initPromise = flag.init()
    // `get()` issued before `init()` settles still sees the read value.
    expect(await flag.get()).toBe('degraded')
    await initPromise
  })

  it('is idempotent within a process — later file edits apply on the next launch', async () => {
    writeFlags({ 'test-flag': { value: 'degraded' } })
    const flag = makeTestFlag()
    const first = flag.init()
    writeFlags({ 'test-flag': { value: 'disabled' } })
    expect(flag.init()).toBe(first)
    await first
    expect(await flag.get()).toBe('degraded')
  })

  it('never writes the file', async () => {
    const flag = makeTestFlag()
    await flag.init()
    expect(fs.existsSync(flagFile())).toBe(false)
  })

  it('holds its own cache — two flags do not share state', async () => {
    writeFlags({ 'test-flag': { value: 'disabled' } })
    const a = makeTestFlag()
    const b = makeOpsFlag<boolean>({ key: 'b-flag', fallback: false, parse: (v) => v === true })
    await Promise.all([a.init(), b.init()])
    expect(await a.get()).toBe('disabled')
    expect(await b.get()).toBe(false)
  })

  it('_resetForTest clears both the cache and the cached read', async () => {
    writeFlags({ 'test-flag': { value: 'disabled' } })
    const flag = makeTestFlag()
    await flag.init()
    expect(await flag.get()).toBe('disabled')

    flag._resetForTest()
    expect(await flag.get()).toBe('normal')

    writeFlags({ 'test-flag': { value: 'degraded' } })
    await flag.init()
    expect(await flag.get()).toBe('degraded')
  })
})
