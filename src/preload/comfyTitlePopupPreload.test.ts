import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: mocks.invoke,
    on: mocks.on,
    removeListener: mocks.removeListener,
    send: mocks.send
  }
}))

import './comfyTitlePopupPreload'
import type { ComfyTitlePopupBridge, PopupGlobalSettingsSnapshot } from './comfyTitlePopupPreload'

const GLOBAL_SETTINGS_CHANNEL = 'comfy-titlepopup:global-settings-changed'

function popupBridge(): ComfyTitlePopupBridge {
  const exposed = mocks.exposeInMainWorld.mock.calls[0]?.[1]
  return (exposed ??
    (globalThis as Record<string, unknown>)['__comfyTitlePopup']) as ComfyTitlePopupBridge
}

/** Minimal snapshot the runtime guard accepts, used as the base every case
 *  mutates one property of. */
function validSnapshot(): PopupGlobalSettingsSnapshot {
  return {
    initialTab: null,
    languageFields: [],
    generalFields: [],
    betaFields: [],
    desktopUpdateFields: [],
    cacheFields: [],
    advancedFields: [],
    sharedDirectoriesFields: [],
    installLocationFields: [],
    modelsDirs: [],
    modelsSystemDefault: '',
    appUpdate: {
      state: {},
      progress: null,
      isDownloading: false,
      capabilities: { systemManaged: false, canSelfUpdate: true },
      installedVersion: '0.0.0-test',
      platform: 'linux',
      lastCheckedAt: null
    },
    githubUrl: '',
    githubStars: null,
    githubStarsLoading: false,
    i18n: {
      overview: '',
      updates: '',
      storage: '',
      models: '',
      advanced: '',
      logs: '',
      sharedDirectories: ''
    }
  }
}

/** Subscribe through the bridge and push `payload` down the real IPC handler
 *  the bridge registered, so the runtime guard is the thing under test. */
function deliver(payload: unknown): unknown[] {
  const received: unknown[] = []
  popupBridge().onGlobalSettingsSnapshot((snapshot) => received.push(snapshot))
  const handler = mocks.on.mock.calls.find(([channel]) => channel === GLOBAL_SETTINGS_CHANNEL)?.[1]
  expect(handler).toBeTypeOf('function')
  ;(handler as (event: unknown, data: unknown) => void)(undefined, payload)
  return received
}

describe('global-settings snapshot guard', () => {
  beforeEach(() => {
    mocks.on.mockClear()
  })

  it('accepts a well-formed snapshot', () => {
    const snapshot = validSnapshot()

    expect(deliver(snapshot)).toEqual([snapshot])
  })

  it('still rejects snapshots that fail the pre-existing field checks', () => {
    expect(deliver({ ...validSnapshot(), modelsSystemDefault: 7 })).toEqual([])
  })
})
