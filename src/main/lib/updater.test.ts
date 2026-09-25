import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UpdaterModule from './updater'

let mockPlatform = 'linux'
let mockAppImage: string | undefined
let mockIsPackaged = true
let mockExePath = '/opt/Comfy Desktop/comfyui-desktop-2'
let mockAppVersion = '1.0.0'

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged
    },
    getPath: (name: string) => {
      if (name === 'exe') return mockExePath
      return ''
    },
    getVersion: () => mockAppVersion,
    releaseSingleInstanceLock: vi.fn()
  },
  ipcMain: {
    handle: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: () => []
  }
}))

vi.mock('@todesktop/runtime', () => ({
  default: { autoUpdater: null }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: { autoInstallOnAppQuit: true }
}))

vi.mock('../settings', () => ({
  get: vi.fn(),
  set: vi.fn()
}))

vi.mock('./quit-state', () => ({
  clearQuitReason: vi.fn(),
  setQuitReason: vi.fn(),
  getQuitReason: vi.fn(() => 'none'),
  isSessionEnding: vi.fn(() => false)
}))

// In-memory stand-in for the durable sidecar loop-breaker marker (issue
// #1367). The real module writes under configDir(), which the electron mock
// resolves to '' here; an in-memory store keeps these suites hermetic while
// letting tests seed a marker, make it unreadable, or force persistence
// failure.
let sidecarMarker: {
  version: string
  attemptedAt: string
  attemptId?: string
} | null = null
let sidecarPersists = true
let sidecarReadable = true
let sidecarClears = true

vi.mock('./startup-attempt-marker', () => ({
  readStartupAttemptMarker: vi.fn(() => {
    if (!sidecarReadable) return { state: 'unavailable' }
    return sidecarMarker ? { state: 'present', marker: sidecarMarker } : { state: 'absent' }
  }),
  recordStartupAttempt: vi.fn((version: string, attemptId?: string) => {
    if (!sidecarPersists) return false
    sidecarMarker = { version, attemptedAt: new Date().toISOString(), attemptId }
    return true
  }),
  clearStartupAttemptMarker: vi.fn(() => {
    if (sidecarClears) sidecarMarker = null
  })
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

/** Import the (freshly-mocked) updater module and register its IPC + listeners. */
async function bootUpdater(): Promise<typeof UpdaterModule> {
  const mod = await import('./updater')
  mod.register()
  return mod
}

// Each test resets the module registry and re-imports the updater module
// graph; the first import in a fresh CI worker can exceed the default 5s
// test timeout under load.
describe('isSystemPackageInstall (via get-update-capabilities)', { timeout: 30_000 }, () => {
  let registeredHandlers: Record<string, (...args: unknown[]) => unknown>

  beforeEach(async () => {
    registeredHandlers = {}
    const { ipcMain } = await import('electron')
    vi.mocked(ipcMain.handle).mockImplementation(((
      channel: string,
      handler: (...args: unknown[]) => unknown
    ) => {
      registeredHandlers[channel] = handler
    }) as typeof ipcMain.handle)

    mockPlatform = 'linux'
    mockAppImage = undefined
    mockIsPackaged = true
    mockExePath = '/opt/Comfy Desktop/comfyui-desktop-2'

    delete process.env.APPIMAGE
    Object.defineProperty(process, 'platform', { value: mockPlatform, configurable: true })

    vi.resetModules()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  async function getCapabilities(): Promise<{ canAutoUpdate: boolean; systemManaged: boolean }> {
    Object.defineProperty(process, 'platform', { value: mockPlatform, configurable: true })
    if (mockAppImage) {
      process.env.APPIMAGE = mockAppImage
    } else {
      delete process.env.APPIMAGE
    }

    vi.resetModules()
    await bootUpdater()
    const handler = registeredHandlers['get-update-capabilities']!
    return handler() as { canAutoUpdate: boolean; systemManaged: boolean }
  }

  it('detects .deb install under /opt/', async () => {
    mockExePath = '/opt/Comfy Desktop/comfyui-desktop-2'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: false, systemManaged: true })
  })

  it('detects .deb install under /usr/', async () => {
    mockExePath = '/usr/lib/comfyui-desktop-2/comfyui-desktop-2'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: false, systemManaged: true })
  })

  it('returns standard for AppImage (APPIMAGE env set)', async () => {
    mockAppImage = '/home/user/Comfy-Desktop.AppImage'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard for Windows', async () => {
    mockPlatform = 'win32'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard for macOS', async () => {
    mockPlatform = 'darwin'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard when not packaged (dev mode)', async () => {
    mockIsPackaged = false
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard for Linux exe under /home/ (manual extract)', async () => {
    mockExePath = '/home/user/apps/comfyui-desktop-2'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard for Linux exe under /tmp/ (temp location)', async () => {
    mockExePath = '/tmp/.mount_comfyui/comfyui-desktop-2'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })
})

/**
 * Download visibility: any in-flight download (auto-on background included)
 * must surface as the `'downloading'` state so the title-bar pill and the
 * Settings progress bar reflect it. Auto-on downloads used to keep the state
 * `null`, leaving the UI claiming "up to date" for the whole download.
 */
describe('app-update state during downloads', () => {
  let listeners: Record<string, Array<(...args: unknown[]) => void>>
  let fakeUpdater: { on: typeof vi.fn; checkForUpdates: ReturnType<typeof vi.fn> }
  let isAutoInstallOn: boolean

  beforeEach(async () => {
    vi.resetModules()
    listeners = {}
    isAutoInstallOn = true
    fakeUpdater = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] || []
        listeners[event].push(cb)
      }) as unknown as typeof vi.fn,
      checkForUpdates: vi.fn(async () => ({ updateInfo: { version: 'unused' } }))
    }
    vi.doMock('@todesktop/runtime', () => ({ default: { autoUpdater: fakeUpdater } }))
    vi.doMock('../settings', () => ({
      get: vi.fn((key: string) => (key === 'autoInstallUpdates' ? isAutoInstallOn : undefined)),
      set: vi.fn()
    }))
  })

  function fire(eventName: string, payload: unknown): void {
    for (const cb of listeners[eventName] || []) cb(payload)
  }

  it('an auto-on background download surfaces as downloading with its version', async () => {
    const updater = await bootUpdater()

    // Auto-on: update-available stays silent (no 'available' pill)...
    fire('update-available', { version: '9.9.9' })
    expect(updater.getCurrentUpdateState().kind).toBeNull()

    // ...but the first progress tick makes the download visible.
    fire('download-progress', { percent: 3 })
    expect(updater.getCurrentUpdateState()).toEqual({
      kind: 'downloading',
      version: '9.9.9',
      autoUpdate: true
    })

    fire('update-downloaded', { version: '9.9.9' })
    expect(updater.getCurrentUpdateState().kind).toBe('ready')
  })

  it('a failed auto-on download returns to the silent idle state', async () => {
    const updater = await bootUpdater()

    fire('update-available', { version: '9.9.9' })
    fire('download-progress', { percent: 3 })
    expect(updater.getCurrentUpdateState().kind).toBe('downloading')

    fire('error', new Error('network blip'))
    expect(updater.getCurrentUpdateState()).toEqual({
      kind: null,
      version: null,
      autoUpdate: true
    })
  })

  it('a failed auto-off download rolls back to available so the user can retry', async () => {
    isAutoInstallOn = false
    const updater = await bootUpdater()

    fire('update-available', { version: '9.9.9' })
    expect(updater.getCurrentUpdateState().kind).toBe('available')

    fire('download-progress', { percent: 3 })
    expect(updater.getCurrentUpdateState()).toEqual({
      kind: 'downloading',
      version: '9.9.9',
      autoUpdate: false
    })

    fire('error', new Error('network blip'))
    expect(updater.getCurrentUpdateState()).toEqual({
      kind: 'available',
      version: '9.9.9',
      autoUpdate: false
    })
  })

  it('progress ticks never downgrade a ready state', async () => {
    const updater = await bootUpdater()

    fire('update-downloaded', { version: '9.9.9' })
    expect(updater.getCurrentUpdateState().kind).toBe('ready')

    // A trailing tick (or a re-validation pass) must not flip ready back.
    fire('download-progress', { percent: 100 })
    expect(updater.getCurrentUpdateState().kind).toBe('ready')
  })
})

/**
 * Issue #1065 — install staged Desktop updates at startup instead of
 * silently on quit, and never spawn the installer while the OS session is
 * ending. Installing on quit is what a Windows shutdown interrupts mid-write,
 * corrupting the install and forcing endless reinstalls.
 */
describe('startup update install + session-end guard (issue #1065)', () => {
  let settingsStore: Record<string, unknown>
  let listeners: Record<string, Array<(...args: unknown[]) => void>>
  let fakeUpdater: {
    on: ReturnType<typeof vi.fn>
    checkForUpdates: ReturnType<typeof vi.fn>
    restartAndInstall: ReturnType<typeof vi.fn>
  }
  let electronUpdaterMock: { autoInstallOnAppQuit: boolean }
  let sessionEnding: boolean
  let readyVersion: string | null
  let quitReason: 'none' | 'user-quit' | 'update-install'

  const originalPlat = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    vi.resetModules()
    settingsStore = {}
    // Startup install and the NSIS installer UI default on (enabled) on Windows.
    // Tests that exercise the opt-out path set these to false explicitly.
    listeners = {}
    sessionEnding = false
    readyVersion = null
    quitReason = 'none'
    sidecarMarker = null
    sidecarPersists = true
    sidecarReadable = true
    sidecarClears = true
    mockAppVersion = '1.0.0'
    delete process.env.E2E
    // Non-system, non-darwin platform so isSystemPackageInstall() is false and
    // installUpdate() skips the darwin single-instance-lock dance.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    fakeUpdater = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] || []
        listeners[event].push(cb)
      }) as ReturnType<typeof vi.fn>,
      // Mimic the ToDesktop wrapper: a successful check of an already-downloaded
      // update re-emits `update-downloaded`, which flips state to 'ready'.
      checkForUpdates: vi.fn(async () => {
        if (readyVersion) {
          for (const cb of listeners['update-downloaded'] || []) cb({ version: readyVersion })
          return { updateInfo: { version: readyVersion } }
        }
        return { updateInfo: null }
      }),
      restartAndInstall: vi.fn()
    }
    electronUpdaterMock = { autoInstallOnAppQuit: true }

    vi.doMock('@todesktop/runtime', () => ({ default: { autoUpdater: fakeUpdater } }))
    vi.doMock('electron-updater', () => ({ autoUpdater: electronUpdaterMock }))
    vi.doMock('./quit-state', () => ({
      clearQuitReason: vi.fn(),
      setQuitReason: vi.fn(),
      getQuitReason: vi.fn(() => quitReason),
      isSessionEnding: vi.fn(() => sessionEnding)
    }))
    vi.doMock('../settings', () => ({
      get: vi.fn((key: string) => settingsStore[key]),
      set: vi.fn((key: string, value: unknown) => {
        if (value === undefined) delete settingsStore[key]
        else settingsStore[key] = value
      })
    }))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlat)
  })

  it('register() disables install-on-quit by default on Windows when startup install is enabled', async () => {
    await bootUpdater()
    // Startup install is the default on Windows, so install-on-quit is disabled
    // entirely and the staged update applies at the next launch.
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(false)
  })

  it('register() keeps install-on-quit when startup install is explicitly opted out', async () => {
    settingsStore['installUpdatesOnStartup'] = false
    await bootUpdater()
    // Opted out: electron-updater's install-on-quit stays armed; it's only
    // suppressed when the OS session ends (see suppressInstallOnQuit).
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(true)
  })

  it('startup install is inert on non-Windows even when the flag is on', async () => {
    // macOS (Squirrel.Mac / ShipIt) and Linux don't have the NSIS shutdown
    // corruption, so startup install must stay off there regardless of the setting.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    settingsStore['installUpdatesOnStartup'] = true
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    readyVersion = '1.0.1'
    const updater = await bootUpdater()
    // register() must NOT disable install-on-quit on macOS.
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(true)
    expect(updater.hasPendingStartupUpdate()).toBe(false)
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
  })

  it('suppressInstallOnQuit() disables install-on-quit for the session-end guard', async () => {
    settingsStore['installUpdatesOnStartup'] = false
    const updater = await bootUpdater()
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(true)
    updater.suppressInstallOnQuit()
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(false)
  })

  it('startup install is inert when opted out, even with a staged update', async () => {
    settingsStore['installUpdatesOnStartup'] = false
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    readyVersion = '1.0.1'
    const updater = await bootUpdater()
    expect(updater.hasPendingStartupUpdate()).toBe(false)
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
  })

  // Issue #1104 — auto-install off: the update still downloads, but it must
  // never install without an explicit pill click (no startup install, no
  // install-on-quit).
  it('register() disables install-on-quit when auto-install is off (opted out of startup install)', async () => {
    settingsStore['installUpdatesOnStartup'] = false
    settingsStore['autoInstallUpdates'] = false
    const updater = await import('./updater')
    updater.register()
    // Without the #1104 gate this would stay armed (the opt-out path) and a
    // staged update would install on the next quit.
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(false)
  })

  it('startup install is inert when auto-install is off, even with a staged update on Windows', async () => {
    settingsStore['autoInstallUpdates'] = false
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    readyVersion = '1.0.1'
    const updater = await import('./updater')
    updater.register()
    expect(updater.hasPendingStartupUpdate()).toBe(false)
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
  })

  it('installUpdate() (pill-confirm path) still installs when auto-install is off', async () => {
    settingsStore['autoInstallUpdates'] = false
    const updater = await import('./updater')
    updater.register()
    updater.installUpdate()
    // The manual path is the whole point of auto-install off — it must work.
    expect(fakeUpdater.restartAndInstall).toHaveBeenCalled()
  })

  it('toggling auto-install re-arms / disarms install-on-quit without a restart', async () => {
    // Opt out of startup install so install-on-quit is the live gate.
    settingsStore['installUpdatesOnStartup'] = false
    const updater = await import('./updater')
    updater.register()
    // Auto-install defaults on → install-on-quit armed.
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(true)

    settingsStore['autoInstallUpdates'] = false
    updater.notifyAutoUpdateChanged()
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(false)

    settingsStore['autoInstallUpdates'] = true
    updater.notifyAutoUpdateChanged()
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(true)
  })

  it('notifyAutoUpdateChanged() never re-arms install-on-quit after session-end suppression', async () => {
    // Opt out of startup install so install-on-quit would otherwise be armed.
    settingsStore['installUpdatesOnStartup'] = false
    const updater = await import('./updater')
    updater.register()
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(true)

    // OS session ends → guard suppresses install-on-quit for the session.
    updater.suppressInstallOnQuit()
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(false)

    // Mid-shutdown setting flips must never re-arm install-on-quit.
    settingsStore['autoInstallUpdates'] = false
    updater.notifyAutoUpdateChanged()
    settingsStore['autoInstallUpdates'] = true
    updater.notifyAutoUpdateChanged()
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(false)
  })

  it('register() disables install-on-quit on macOS when auto-install is off', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    settingsStore['autoInstallUpdates'] = false
    const updater = await import('./updater')
    updater.register()
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(false)
  })

  it('installUpdate() is a no-op while the OS session is ending', async () => {
    sessionEnding = true
    const updater = await bootUpdater()
    updater.installUpdate()
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
  })

  it('installUpdate() shows the NSIS installer UI by default on Windows', async () => {
    const updater = await bootUpdater()
    updater.installUpdate()
    expect(fakeUpdater.restartAndInstall).toHaveBeenCalledWith({ isSilent: false })
  })

  it('installUpdate() installs silently when showInstallerUI is opted out', async () => {
    settingsStore['showInstallerUI'] = false
    const updater = await bootUpdater()
    updater.installUpdate()
    expect(fakeUpdater.restartAndInstall).toHaveBeenCalledWith({ isSilent: true })
  })

  it('installUpdate() ignores showInstallerUI off Windows (isSilent stays true)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    settingsStore['showInstallerUI'] = true
    const updater = await bootUpdater()
    updater.installUpdate()
    expect(fakeUpdater.restartAndInstall).toHaveBeenCalledWith({ isSilent: true })
  })

  it('hasPendingStartupUpdate() reflects the staged-update markers', async () => {
    const updater = await import('./updater')

    expect(updater.hasPendingStartupUpdate()).toBe(false)

    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    expect(updater.hasPendingStartupUpdate()).toBe(true)

    // Staged version is already what we are running.
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.0'
    expect(updater.hasPendingStartupUpdate()).toBe(false)

    // Loop-breaker: already auto-attempted this version.
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    settingsStore['lastStartupUpdateAttemptVersion'] = '1.0.1'
    expect(updater.hasPendingStartupUpdate()).toBe(false)
  })

  it('applyPendingUpdateOnStartup() installs a staged update and records the attempt', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    readyVersion = '1.0.1'
    const updater = await bootUpdater()

    const installing = await updater.applyPendingUpdateOnStartup()

    expect(installing).toBe(true)
    expect(fakeUpdater.restartAndInstall).toHaveBeenCalledTimes(1)
    expect(settingsStore['lastStartupUpdateAttemptVersion']).toBe('1.0.1')
    expect(sidecarMarker?.attemptId).toEqual(expect.any(String))
  })

  it('applyPendingUpdateOnStartup() holds the install after committing so the countdown plays out', async () => {
    vi.useFakeTimers()
    try {
      settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
      readyVersion = '1.0.1' // check resolves instantly (cached installer)
      const updater = await import('./updater')
      updater.register()

      // A splash is up: the commit hook fires once the install is confirmed,
      // then the full post-commit hold (5000ms) must elapse before the install.
      const onInstallCommitted = vi.fn()
      const pending = updater.applyPendingUpdateOnStartup({ onInstallCommitted })

      // Let the (instant) ready check settle, but stay short of the hold.
      await vi.advanceTimersByTimeAsync(4000)
      expect(onInstallCommitted).toHaveBeenCalledTimes(1)
      expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()

      // Cross the floor — the install now fires.
      await vi.advanceTimersByTimeAsync(1200)
      expect(await pending).toBe(true)
      expect(fakeUpdater.restartAndInstall).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applyPendingUpdateOnStartup() does nothing when no update is staged', async () => {
    const updater = await bootUpdater()
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
  })

  it('applyPendingUpdateOnStartup() does not install when the check cannot confirm a ready update', async () => {
    vi.useFakeTimers()
    try {
      settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
      // The check finds the update upstream but it never reaches 'ready' and
      // never starts re-downloading (e.g. the updater stalls silently).
      fakeUpdater.checkForUpdates = vi.fn(async () => ({ updateInfo: { version: '1.0.1' } }))
      const updater = await import('./updater')
      updater.register()
      const pending = updater.applyPendingUpdateOnStartup()
      // No 'ready' transition arrives, so the bounded wait falls through on its
      // timeout rather than hanging boot forever. Advance just past the 5000ms
      // timeout so the check settles regardless of event-loop boundary timing.
      await vi.advanceTimersByTimeAsync(5100)
      expect(await pending).toBe(false)
      expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('loop-breaker: a previously-attempted version is not auto-retried', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    settingsStore['lastStartupUpdateAttemptVersion'] = '1.0.1'
    readyVersion = '1.0.1'
    const updater = await bootUpdater()
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
  })

  it('bails out fast when the staged installer is invalid and a re-download starts', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    // The feed still offers the update, but the cached installer was rejected:
    // the check resolves without an 'update-downloaded' (no ready state) and
    // electron-updater starts re-downloading the installer.
    fakeUpdater.checkForUpdates = vi.fn(async () => ({ updateInfo: { version: '1.0.1' } }))
    const updater = await bootUpdater()
    const pending = updater.applyPendingUpdateOnStartup()
    // First raw download-progress tick: proof of the re-download. The wait must
    // settle on it immediately so the user gets into the app while the download
    // continues in the background.
    for (const cb of listeners['download-progress'] || []) cb({ percent: 1 })
    expect(await pending).toBe(false)
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
    // No attempt marker: nothing was installed, so the loop-breaker stays
    // unarmed and a completed download can install on a later boot.
    expect(settingsStore['lastStartupUpdateAttemptVersion']).toBeUndefined()
    expect(settingsStore['pendingDownloadedUpdateVersion']).toBe('1.0.1')
  })

  it('abandons the staged version after repeated not-ready boots', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    readyVersion = null // never becomes ready on any boot
    const updater = await bootUpdater()

    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(settingsStore['startupInstallNotReadyCount']).toBe(1)
    expect(settingsStore['pendingDownloadedUpdateVersion']).toBe('1.0.1')

    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(settingsStore['startupInstallNotReadyCount']).toBe(2)
    expect(settingsStore['pendingDownloadedUpdateVersion']).toBe('1.0.1')

    // Third consecutive strike: the staged marker is abandoned so later boots
    // stop showing the update splash for an install that never becomes ready.
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(settingsStore['pendingDownloadedUpdateVersion']).toBeUndefined()
    expect(settingsStore['startupInstallNotReadyVersion']).toBeUndefined()
    expect(settingsStore['startupInstallNotReadyCount']).toBeUndefined()

    // With the marker gone, the next boot is a normal one (no splash, no wait).
    expect(updater.hasPendingStartupUpdate()).toBe(false)
  })

  it('does not abandon a version restaged during the wait', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    settingsStore['startupInstallNotReadyVersion'] = '1.0.1'
    settingsStore['startupInstallNotReadyCount'] = 2
    // On what would be 1.0.1's third strike, a newer installer finishes
    // downloading during the check: update-downloaded restages the pending
    // marker to 1.0.2 and flips the state to ready for 1.0.2.
    fakeUpdater.checkForUpdates = vi.fn(async () => {
      for (const cb of listeners['update-downloaded'] || []) cb({ version: '1.0.2' })
      return { updateInfo: { version: '1.0.2' } }
    })
    const updater = await bootUpdater()
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    // The restaged 1.0.2 marker must survive 1.0.1's strikes.
    expect(settingsStore['pendingDownloadedUpdateVersion']).toBe('1.0.2')
    expect(settingsStore['startupInstallNotReadyVersion']).toBeUndefined()
    expect(settingsStore['startupInstallNotReadyCount']).toBeUndefined()
  })

  it('skips without starting the countdown when the session begins ending during the check', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    // The OS session starts ending while the ready check is in flight.
    fakeUpdater.checkForUpdates = vi.fn(async () => {
      sessionEnding = true
      for (const cb of listeners['update-downloaded'] || []) cb({ version: '1.0.1' })
      return { updateInfo: { version: '1.0.1' } }
    })
    const updater = await bootUpdater()
    const onInstallCommitted = vi.fn()
    expect(await updater.applyPendingUpdateOnStartup({ onInstallCommitted })).toBe(false)
    // The user must never watch an install countdown for an aborted install.
    expect(onInstallCommitted).not.toHaveBeenCalled()
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
    // No attempt marker was written, so the install retries on the next boot.
    expect(settingsStore['lastStartupUpdateAttemptVersion']).toBeUndefined()
  })

  it('a different staged version restarts the not-ready strike count', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.2'
    settingsStore['startupInstallNotReadyVersion'] = '1.0.1'
    settingsStore['startupInstallNotReadyCount'] = 2
    readyVersion = null
    const updater = await bootUpdater()
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(settingsStore['startupInstallNotReadyVersion']).toBe('1.0.2')
    expect(settingsStore['startupInstallNotReadyCount']).toBe(1)
    expect(settingsStore['pendingDownloadedUpdateVersion']).toBe('1.0.2')
  })

  it('clears the not-ready strike counter when the staged update installs', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    settingsStore['startupInstallNotReadyVersion'] = '1.0.1'
    settingsStore['startupInstallNotReadyCount'] = 2
    readyVersion = '1.0.1'
    const updater = await bootUpdater()
    expect(await updater.applyPendingUpdateOnStartup()).toBe(true)
    expect(settingsStore['startupInstallNotReadyVersion']).toBeUndefined()
    expect(settingsStore['startupInstallNotReadyCount']).toBeUndefined()
  })

  it('clears a stale not-ready counter once its version is no longer newer', async () => {
    settingsStore['startupInstallNotReadyVersion'] = '1.0.0'
    settingsStore['startupInstallNotReadyCount'] = 2
    mockAppVersion = '1.0.0' // that version is now running
    const updater = await bootUpdater()
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(settingsStore['startupInstallNotReadyVersion']).toBeUndefined()
    expect(settingsStore['startupInstallNotReadyCount']).toBeUndefined()
  })

  it('clears stale markers once the staged version is actually running', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.0'
    settingsStore['lastStartupUpdateAttemptVersion'] = '1.0.0'
    mockAppVersion = '1.0.0' // install succeeded; we now run it
    const updater = await bootUpdater()
    await updater.applyPendingUpdateOnStartup()
    expect(settingsStore['pendingDownloadedUpdateVersion']).toBeUndefined()
    expect(settingsStore['lastStartupUpdateAttemptVersion']).toBeUndefined()
  })

  // Issue #1367 - a stale .bak restore of settings.json can erase the settings
  // copy of the loop-breaker marker while the pending-update marker survives.
  // The durable sidecar marker must break the loop on its own, and installs
  // must fail closed when it can't persist.
  it('loop-breaker trips on the sidecar marker alone when the settings marker was erased (issue #1367)', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    // No settings marker - it was rolled back - but the sidecar remembers.
    sidecarMarker = { version: '1.0.1', attemptedAt: new Date().toISOString() }
    readyVersion = '1.0.1'
    const updater = await bootUpdater()
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
  })

  it('fails closed - no install - when the sidecar marker cannot be persisted (issue #1367)', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    readyVersion = '1.0.1'
    sidecarPersists = false
    const updater = await bootUpdater()
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
    // No marker may be written on the fail-closed path: a lone settings marker
    // would trip the loop-breaker forever instead of retrying next launch.
    expect(settingsStore['lastStartupUpdateAttemptVersion']).toBeUndefined()
  })

  it('fails closed - no install - when the sidecar marker exists but is unreadable (issue #1367)', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    readyVersion = '1.0.1'
    // The sidecar file exists but reads keep failing (e.g. AV lock outlasting
    // the retry budget). It may record an attempt of exactly this version, so
    // treating it as absent would reopen the reinstall loop.
    sidecarReadable = false
    const updater = await bootUpdater()
    expect(updater.hasPendingStartupUpdate()).toBe(false)
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
  })

  it('a failed attempt on one version does not block a newer staged version', async () => {
    // Version 1.0.1 was attempted and failed (still running 1.0.0); a newer
    // 1.0.2 has since been staged. The loop-breaker is per-version, so 1.0.2
    // must install and take over both markers.
    settingsStore['lastStartupUpdateAttemptVersion'] = '1.0.1'
    sidecarMarker = { version: '1.0.1', attemptedAt: new Date().toISOString() }
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.2'
    readyVersion = '1.0.2'
    const updater = await bootUpdater()
    expect(await updater.applyPendingUpdateOnStartup()).toBe(true)
    expect(fakeUpdater.restartAndInstall).toHaveBeenCalledTimes(1)
    expect(settingsStore['lastStartupUpdateAttemptVersion']).toBe('1.0.2')
    expect(sidecarMarker?.version).toBe('1.0.2')
  })

  it('an explicit installUpdate() call bypasses the startup loop-breaker', async () => {
    // The loop-breaker only guards AUTOMATIC startup installs; a user clicking
    // the "update ready" pill must always be able to install.
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    settingsStore['lastStartupUpdateAttemptVersion'] = '1.0.1'
    sidecarMarker = { version: '1.0.1', attemptedAt: new Date().toISOString() }
    const updater = await bootUpdater()
    updater.installUpdate()
    expect(fakeUpdater.restartAndInstall).toHaveBeenCalledTimes(1)
  })

  it('records the sidecar marker alongside the settings marker when installing', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    readyVersion = '1.0.1'
    const updater = await bootUpdater()
    expect(await updater.applyPendingUpdateOnStartup()).toBe(true)
    expect(fakeUpdater.restartAndInstall).toHaveBeenCalledTimes(1)
    expect(settingsStore['lastStartupUpdateAttemptVersion']).toBe('1.0.1')
    expect(sidecarMarker?.version).toBe('1.0.1')
  })

  it('clears a stale sidecar marker once the staged version is actually running', async () => {
    sidecarMarker = { version: '1.0.0', attemptedAt: new Date().toISOString() }
    mockAppVersion = '1.0.0' // install succeeded; we now run it
    const updater = await bootUpdater()
    await updater.applyPendingUpdateOnStartup()
    expect(sidecarMarker).toBeNull()
  })
})

/**
 * Issue #1161 — the updater must only ever act on a version that is STRICTLY
 * newer than the running build. The engine can re-surface the current (or an
 * older, or an equal-build-restringed) version; acting on it drives the
 * download -> "Updating..." splash -> install -> relaunch loop that never
 * converges on an already-latest machine. RC releases of a higher version must
 * still install (we ship IP-whitelisted RCs to test update code).
 */
describe('version guard: reject non-newer offers (issue #1161)', () => {
  let listeners: Record<string, Array<(...args: unknown[]) => void>>
  let settingsStore: Record<string, unknown>
  let fakeUpdater: { on: ReturnType<typeof vi.fn>; checkForUpdates: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.resetModules()
    listeners = {}
    settingsStore = {}
    sidecarMarker = null
    sidecarPersists = true
    sidecarReadable = true
    sidecarClears = true
    mockAppVersion = '1.0.24'
    fakeUpdater = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] || []
        listeners[event].push(cb)
      }) as ReturnType<typeof vi.fn>,
      checkForUpdates: vi.fn(async () => ({ updateInfo: null }))
    }
    vi.doMock('@todesktop/runtime', () => ({ default: { autoUpdater: fakeUpdater } }))
    vi.doMock('../settings', () => ({
      get: vi.fn((key: string) =>
        key === 'autoInstallUpdates' ? (settingsStore[key] ?? true) : settingsStore[key]
      ),
      set: vi.fn((key: string, value: unknown) => {
        if (value === undefined) delete settingsStore[key]
        else settingsStore[key] = value
      })
    }))
  })

  function fire(eventName: string, payload: unknown): void {
    for (const cb of listeners[eventName] || []) cb(payload)
  }

  it('update-downloaded for the SAME version does not stage a pending update', async () => {
    const updater = await bootUpdater()

    fire('update-downloaded', { version: '1.0.24' })

    expect(settingsStore['pendingDownloadedUpdateVersion']).toBeUndefined()
    expect(updater.getCurrentUpdateState().kind).toBeNull()
  })

  it('update-downloaded for an OLDER version does not stage a pending update', async () => {
    const updater = await bootUpdater()

    fire('update-downloaded', { version: '1.0.22' })

    expect(settingsStore['pendingDownloadedUpdateVersion']).toBeUndefined()
    expect(updater.getCurrentUpdateState().kind).toBeNull()
  })

  it('update-downloaded for an equal build with different metadata is ignored', async () => {
    const updater = await bootUpdater()

    fire('update-downloaded', { version: '1.0.24+build.7' })

    expect(settingsStore['pendingDownloadedUpdateVersion']).toBeUndefined()
    expect(updater.getCurrentUpdateState().kind).toBeNull()
  })

  it('update-downloaded tolerates a leading "v" on a newer version and stages it', async () => {
    const updater = await bootUpdater()

    fire('update-downloaded', { version: 'v1.0.25' })

    expect(settingsStore['pendingDownloadedUpdateVersion']).toBe('v1.0.25')
    expect(updater.getCurrentUpdateState()).toMatchObject({ kind: 'ready', version: 'v1.0.25' })
  })

  it('update-downloaded ignores a leading "v" on the current version', async () => {
    const updater = await bootUpdater()

    fire('update-downloaded', { version: 'v1.0.24' })

    expect(settingsStore['pendingDownloadedUpdateVersion']).toBeUndefined()
    expect(updater.getCurrentUpdateState().kind).toBeNull()
  })

  it('update-downloaded stages a newer version carrying build metadata', async () => {
    const updater = await bootUpdater()

    fire('update-downloaded', { version: '1.0.25+build.7' })

    expect(settingsStore['pendingDownloadedUpdateVersion']).toBe('1.0.25+build.7')
    expect(updater.getCurrentUpdateState().kind).toBe('ready')
  })

  it('update-downloaded for a genuinely NEWER version stages it', async () => {
    const updater = await bootUpdater()

    fire('update-downloaded', { version: '1.0.25' })

    expect(settingsStore['pendingDownloadedUpdateVersion']).toBe('1.0.25')
    expect(updater.getCurrentUpdateState()).toMatchObject({ kind: 'ready', version: '1.0.25' })
  })

  it('update-downloaded for an RC of a HIGHER version stages it (RC support)', async () => {
    const updater = await bootUpdater()

    fire('update-downloaded', { version: '1.0.25-rc.1' })

    expect(settingsStore['pendingDownloadedUpdateVersion']).toBe('1.0.25-rc.1')
    expect(updater.getCurrentUpdateState()).toMatchObject({ kind: 'ready', version: '1.0.25-rc.1' })
  })

  it('update-downloaded for an RC of the CURRENT version is ignored (rc < release)', async () => {
    const updater = await bootUpdater()

    fire('update-downloaded', { version: '1.0.24-rc.1' })

    expect(settingsStore['pendingDownloadedUpdateVersion']).toBeUndefined()
    expect(updater.getCurrentUpdateState().kind).toBeNull()
  })

  it('update-available for a non-newer version is ignored (no available pill)', async () => {
    settingsStore['autoInstallUpdates'] = false // surface the 'available' pill path
    const updater = await bootUpdater()

    fire('update-available', { version: '1.0.24' })

    expect(updater.getCurrentUpdateState().kind).toBeNull()
  })

  it('runCheck reports a non-newer surfaced version as unavailable', async () => {
    fakeUpdater.checkForUpdates = vi.fn(async () => ({ updateInfo: { version: '1.0.24' } }))
    const updater = await bootUpdater()

    const result = await updater.runCheck('manual-check')

    expect(result).toEqual({ available: false })
  })

  it('runCheck reports a newer surfaced version as available', async () => {
    fakeUpdater.checkForUpdates = vi.fn(async () => ({ updateInfo: { version: '1.0.25' } }))
    const updater = await bootUpdater()

    const result = await updater.runCheck('manual-check')

    expect(result).toEqual({ available: true, version: '1.0.25' })
  })

  it('hasPendingStartupUpdate ignores a stale non-newer pending marker', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.20'
    const updater = await bootUpdater()

    expect(updater.hasPendingStartupUpdate()).toBe(false)
  })

  it('applyPendingUpdateOnStartup clears a stale non-newer pending marker', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.20'
    settingsStore['lastStartupUpdateAttemptVersion'] = '1.0.20'
    const updater = await bootUpdater()

    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(settingsStore['pendingDownloadedUpdateVersion']).toBeUndefined()
    expect(settingsStore['lastStartupUpdateAttemptVersion']).toBeUndefined()
  })
})
