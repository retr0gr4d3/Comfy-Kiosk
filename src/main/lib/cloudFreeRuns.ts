/**
 * Free-tier availability for the first-use "5 FREE RUNS" pill.
 *
 * Keyed on cloud's own `free_tier_workflow_submission_enabled`, but resolved from the local
 * `ops-flags.json` (see `opsFlag.ts`); with no entry there it stays off.
 *
 * Fails CLOSED: the pill asserts a live entitlement, and advertising runs that aren't
 * granted is worse than showing nothing.
 */
import { makeOpsFlag } from './opsFlag'

export const CLOUD_FREE_RUNS_FLAG_KEY = 'free_tier_workflow_submission_enabled'

const flag = makeOpsFlag<boolean>({
  key: CLOUD_FREE_RUNS_FLAG_KEY,
  fallback: false,
  // Explicit yes only — `'off'`, `undefined`, and any unrecognised string all read as false.
  parse: (value) => value === true || value === 'on'
})

/** Boot-time read. Idempotent within a process; never rejects. */
export const initCloudFreeRuns = flag.init

/** Awaits the boot read so renderer queries landing before it settles still get the
 *  resolved value, not the fail-closed default. */
export const getCloudFreeRunsEnabledAsync = flag.get

/** @internal — exposed for tests. */
export const _resetForTest = flag._resetForTest
