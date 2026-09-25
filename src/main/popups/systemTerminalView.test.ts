import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const onHandlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  const invokeHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const exitListeners: Array<() => void> = []
  const views: Array<{
    popup: {
      webContents: { id: number; send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean }
      setBounds: ReturnType<typeof vi.fn>
    }
    parentWindow: unknown
    parentWindowId: number
    popupWebContentsId: number
    rendererReady: boolean
    isOpen: boolean
    showOnTop: ReturnType<typeof vi.fn>
    hide: ReturnType<typeof vi.fn>
    isDestroyed: () => boolean
  }> = []
  let nextId = 100
  return {
    onHandlers,
    invokeHandlers,
    exitListeners,
    views,
    focused: null as unknown,
    nextWcId: () => nextId++,
    subscribe: vi.fn(async () => ({ buffer: [], size: { cols: 80, rows: 24 }, exited: false })),
    write: vi.fn(),
    resize: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) =>
      h.onHandlers.set(channel, fn),
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      h.invokeHandlers.set(channel, fn)
  },
  webContents: { getFocusedWebContents: () => h.focused }
}))
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }))
vi.mock('../lib/titleBarOverlay', () => ({ TITLEBAR_HEIGHT: 32 }))
vi.mock('../lib/systemTerminal', () => ({
  subscribeSystemTerminal: h.subscribe,
  writeSystemTerminal: h.write,
  resizeSystemTerminal: h.resize,
  onSystemTerminalExit: (fn: () => void) => {
    h.exitListeners.push(fn)
    return () => {}
  }
}))
vi.mock('./embeddedPopupView', () => ({
  EmbeddedPopupView: class {
    popup: (typeof h.views)[number]['popup']
    parentWindow: { id: number }
    parentWindowId: number
    popupWebContentsId: number
    rendererReady = false
    isOpen = false
    showOnTop = vi.fn(() => {
      this.isOpen = true
    })
    hide = vi.fn(() => {
      this.isOpen = false
    })
    constructor(opts: { parent: { id: number } }) {
      const id = h.nextWcId()
      this.parentWindow = opts.parent
      this.parentWindowId = opts.parent.id
      this.popupWebContentsId = id
      this.popup = {
        webContents: { id, send: vi.fn(), isDestroyed: () => false },
        setBounds: vi.fn()
      }
      h.views.push(this as unknown as (typeof h.views)[number])
    }
    isDestroyed() {
      return false
    }
  }
}))

import {
  closeSystemTerminal,
  isSystemTerminalOpen,
  openSystemTerminal,
  raiseSystemTerminalIfOpen,
  registerSystemTerminalIpc,
  toggleSystemTerminal,
  _resetSystemTerminalOverlaysForTest
} from './systemTerminalView'

let nextWindowId = 1
function fakeWindow() {
  return {
    id: nextWindowId++,
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    on: vi.fn(),
    removeListener: vi.fn(),
    focus: vi.fn()
  } as unknown as Electron.BrowserWindow & { focus: ReturnType<typeof vi.fn> }
}

function fakeFocusTarget() {
  return { isDestroyed: () => false, focus: vi.fn() }
}

function sender(id: number) {
  return { sender: { id } }
}

function fire(channel: string, id: number, ...args: unknown[]): void {
  h.onHandlers.get(channel)!(sender(id), ...args)
}

registerSystemTerminalIpc()

beforeEach(() => {
  vi.useFakeTimers()
  h.views.length = 0
  h.focused = null
  h.subscribe.mockClear()
  h.write.mockClear()
  h.resize.mockClear()
})

afterEach(() => {
  _resetSystemTerminalOverlaysForTest()
  vi.useRealTimers()
})

describe('system terminal overlay', () => {
  it('waits for the renderer before showing, then covers the body below the title bar', () => {
    const win = fakeWindow()
    openSystemTerminal(win)
    const view = h.views[0]!
    expect(view.showOnTop).not.toHaveBeenCalled()
    expect(isSystemTerminalOpen(win)).toBe(true)

    fire('system-terminal:ready', view.popupWebContentsId)
    expect(view.showOnTop).toHaveBeenCalledWith({ focus: true })
    expect(view.popup.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 33,
      width: 1280,
      height: 767
    })
    expect(view.popup.webContents.send).toHaveBeenCalledWith('system-terminal:show', {
      title: 'systemTerminal.title',
      hint: 'systemTerminal.hint',
      close: 'systemTerminal.close'
    })
  })

  it('reuses one view per window and toggles it', () => {
    const win = fakeWindow()
    toggleSystemTerminal(win)
    fire('system-terminal:ready', h.views[0]!.popupWebContentsId)
    expect(isSystemTerminalOpen(win)).toBe(true)

    toggleSystemTerminal(win)
    expect(isSystemTerminalOpen(win)).toBe(false)
    fire('system-terminal:hidden', h.views[0]!.popupWebContentsId)

    toggleSystemTerminal(win)
    expect(h.views).toHaveLength(1)
    expect(h.views[0]!.showOnTop).toHaveBeenCalledTimes(2)
  })

  it('plays the exit animation, then hides and returns focus to the previous view', () => {
    const win = fakeWindow()
    const previous = fakeFocusTarget()
    h.focused = previous
    openSystemTerminal(win)
    const view = h.views[0]!
    fire('system-terminal:ready', view.popupWebContentsId)
    h.focused = view.popup.webContents

    closeSystemTerminal(win)
    expect(view.popup.webContents.send).toHaveBeenCalledWith('system-terminal:hide')
    expect(view.hide).not.toHaveBeenCalled()

    fire('system-terminal:hidden', view.popupWebContentsId)
    expect(view.hide).toHaveBeenCalledTimes(1)
    expect(previous.focus).toHaveBeenCalledTimes(1)
  })

  it('leaves focus alone when something else took it during the exit animation', () => {
    const win = fakeWindow()
    const previous = fakeFocusTarget()
    h.focused = previous
    openSystemTerminal(win)
    const view = h.views[0]!
    fire('system-terminal:ready', view.popupWebContentsId)
    closeSystemTerminal(win)
    h.focused = fakeFocusTarget()
    fire('system-terminal:hidden', view.popupWebContentsId)
    expect(view.hide).toHaveBeenCalledTimes(1)
    expect(previous.focus).not.toHaveBeenCalled()
    expect(win.focus).not.toHaveBeenCalled()
  })

  it('hides anyway when the renderer never acks the exit animation', () => {
    const win = fakeWindow()
    openSystemTerminal(win)
    const view = h.views[0]!
    fire('system-terminal:ready', view.popupWebContentsId)
    closeSystemTerminal(win)
    vi.advanceTimersByTime(300)
    expect(view.hide).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalled()
  })

  it('stays open when re-toggled mid exit animation', () => {
    const win = fakeWindow()
    openSystemTerminal(win)
    const view = h.views[0]!
    fire('system-terminal:ready', view.popupWebContentsId)
    closeSystemTerminal(win)
    toggleSystemTerminal(win)
    vi.advanceTimersByTime(1000)
    fire('system-terminal:hidden', view.popupWebContentsId)
    expect(view.hide).not.toHaveBeenCalled()
    expect(isSystemTerminalOpen(win)).toBe(true)
  })

  it('cancels an open that is still waiting on the renderer', () => {
    const win = fakeWindow()
    openSystemTerminal(win)
    closeSystemTerminal(win)
    fire('system-terminal:ready', h.views[0]!.popupWebContentsId)
    expect(h.views[0]!.showOnTop).not.toHaveBeenCalled()
  })

  it('re-raises only an open overlay', () => {
    const win = fakeWindow()
    raiseSystemTerminalIfOpen(win)
    openSystemTerminal(win)
    const view = h.views[0]!
    fire('system-terminal:ready', view.popupWebContentsId)
    raiseSystemTerminalIfOpen(win)
    expect(view.showOnTop).toHaveBeenCalledTimes(2)
    expect(view.showOnTop).toHaveBeenLastCalledWith()
  })

  it('closes every overlay when the shell exits', () => {
    const a = fakeWindow()
    const b = fakeWindow()
    for (const win of [a, b]) openSystemTerminal(win)
    for (const view of h.views) fire('system-terminal:ready', view.popupWebContentsId)
    for (const listener of h.exitListeners) listener()
    expect(isSystemTerminalOpen(a)).toBe(false)
    expect(isSystemTerminalOpen(b)).toBe(false)
  })

  it('closes on the renderer close request', () => {
    const win = fakeWindow()
    openSystemTerminal(win)
    const view = h.views[0]!
    fire('system-terminal:ready', view.popupWebContentsId)
    fire('system-terminal:request-close', view.popupWebContentsId)
    expect(isSystemTerminalOpen(win)).toBe(false)
  })
})

describe('system terminal IPC scoping', () => {
  it('serves shell I/O to overlay renderers', async () => {
    openSystemTerminal(fakeWindow())
    const id = h.views[0]!.popupWebContentsId
    await h.invokeHandlers.get('system-terminal:subscribe')!(sender(id))
    fire('system-terminal:write', id, 'ls\r')
    fire('system-terminal:resize', id, 100, 30)
    expect(h.subscribe).toHaveBeenCalledTimes(1)
    expect(h.write).toHaveBeenCalledWith('ls\r')
    expect(h.resize).toHaveBeenCalledWith(100, 30)
  })

  it('ignores every other sender, including the ComfyUI page', async () => {
    const stranger = 9999
    expect(await h.invokeHandlers.get('system-terminal:subscribe')!(sender(stranger))).toBeNull()
    fire('system-terminal:write', stranger, 'rm -rf ~\r')
    fire('system-terminal:resize', stranger, 1, 1)
    expect(h.subscribe).not.toHaveBeenCalled()
    expect(h.write).not.toHaveBeenCalled()
    expect(h.resize).not.toHaveBeenCalled()
  })

  it('rejects malformed payloads from an overlay', () => {
    openSystemTerminal(fakeWindow())
    const id = h.views[0]!.popupWebContentsId
    fire('system-terminal:write', id, { not: 'a string' })
    fire('system-terminal:resize', id, '100', 30)
    expect(h.write).not.toHaveBeenCalled()
    expect(h.resize).not.toHaveBeenCalled()
  })
})
