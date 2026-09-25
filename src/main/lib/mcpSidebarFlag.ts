/**
 * Gate for the Local MCP sidebar icon injected into local installs.
 *
 * Off unless `ops-flags.json` enables it (see `opsFlag.ts`), matching upstream's control arm.
 */
import { makeOpsFlag } from './opsFlag'

export const MCP_SIDEBAR_FLAG_KEY = 'mcp_sidebar_enabled'

const flag = makeOpsFlag<boolean>({
  key: MCP_SIDEBAR_FLAG_KEY,
  fallback: false,
  parse: (value) => value === true
})

/** Boot-time read. Idempotent within a process; never rejects. */
export const initMcpSidebarFlag = flag.init

/** Awaits the boot read so an attach racing boot still sees the resolved value. */
export const getMcpSidebarEnabledAsync = flag.get

/** @internal — exposed for tests. */
export const _resetForTest = flag._resetForTest
