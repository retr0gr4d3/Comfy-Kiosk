// Fail-closed semantics for the free-tier availability lookup.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let testConfigDir = ''
vi.mock('./paths', () => ({
  configDir: () => testConfigDir
}))

import {
  initCloudFreeRuns,
  getCloudFreeRunsEnabledAsync,
  CLOUD_FREE_RUNS_FLAG_KEY,
  _resetForTest
} from './cloudFreeRuns'

async function resolveWith(value: unknown): Promise<boolean> {
  fs.writeFileSync(
    path.join(testConfigDir, 'ops-flags.json'),
    JSON.stringify({ [CLOUD_FREE_RUNS_FLAG_KEY]: { value } })
  )
  await initCloudFreeRuns()
  return getCloudFreeRunsEnabledAsync()
}

beforeEach(() => {
  _resetForTest()
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-free-runs-'))
})

afterEach(() => {
  fs.rmSync(testConfigDir, { recursive: true, force: true })
})

describe('cloudFreeRuns', () => {
  it('keys on cloud’s own free-tier flag name', () => {
    expect(CLOUD_FREE_RUNS_FLAG_KEY).toBe('free_tier_workflow_submission_enabled')
  })

  it.each([['on'], [true]])('%s enables the pill', async (value) => {
    expect(await resolveWith(value)).toBe(true)
  })

  it.each([['off'], [false], ['garbage']])('keeps the pill hidden for %s', async (value) => {
    // The pill asserts a live entitlement. Anything short of an explicit
    // yes means we can't confirm the offer, so we don't make it.
    expect(await resolveWith(value)).toBe(false)
  })

  it('keeps the pill hidden when ops-flags.json has no entry', async () => {
    await initCloudFreeRuns()
    expect(await getCloudFreeRunsEnabledAsync()).toBe(false)
  })
})
