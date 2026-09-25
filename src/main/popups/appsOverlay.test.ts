import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const onHandlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  return {
    onHandlers,
    views: [] as Array<{
      popup: {
        webContents: {
          id: number
          send: ReturnType<typeof vi.fn>
          focus: ReturnType<typeof vi.fn>
          isDestroyed: () => boolean
        }
        setBounds: ReturnType<typeof vi.fn>
      }
      parentWindow: unknown
      parentWindowId: number
      popupWebContentsId: number
      rendererReady: boolean
      isOpen: boolean
      showOnTop: ReturnType<typeof vi.fn>
      hide: ReturnType<typeof vi.fn>
    }>,
    tabs: [] as Array<
      Record<
        | 'open'
        | 'close'
        | 'activate'
        | 'cycle'
        | 'navigate'
        | 'back'
        | 'forward'
        | 'reload'
        | 'stop'
        | 'focusActive'
        | 'setContentRect'
        | 'layout'
        | 'hideAll'
        | 'destroy'
        | 'state',
        ReturnType<typeof vi.fn>
      > & { owned: unknown[] }
    >,
    focused: null as unknown,
    downloadListener: null as null | ((n: unknown) => void),
    config: {
      homeUrl: 'https://home.example/',
      searchTemplate: 'https://s.example/?q=%s',
      apps: [
        { id: 'browser', name: 'Browser', kind: 'browser' },
        { id: 'terminal', name: 'Terminal', kind: 'terminal' },
        { id: 'web:docs', name: 'Docs', kind: 'web', url: 'https://docs.example/' }
      ]
    },
    nextId: 200
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) =>
      h.onHandlers.set(channel, fn)
  },
  webContents: { getFocusedWebContents: () => h.focused }
}))
vi.mock('../lib/i18n', () => ({
  t: (key: string, params?: Record<string, string>) =>
    params ? `${key}:${JSON.stringify(params)}` : key
}))
vi.mock('../lib/titleBarOverlay', () => ({ TITLEBAR_HEIGHT: 32 }))
vi.mock('../lib/appsConfig', () => ({ loadAppsConfig: () => h.config }))
vi.mock('../lib/containedBrowserSession', () => ({
  setContainedDownloadListener: (fn: (n: unknown) => void) => {
    h.downloadListener = fn
  }
}))
vi.mock('../lib/browserTabs', () => ({
  BrowserTabs: class {
    owned: unknown[] = []
    activeTabId: number | null = null
    open = vi.fn()
    close = vi.fn()
    activate = vi.fn()
    cycle = vi.fn()
    navigate = vi.fn()
    back = vi.fn()
    forward = vi.fn()
    reload = vi.fn()
    stop = vi.fn()
    focusActive = vi.fn()
    setContentRect = vi.fn()
    layout = vi.fn()
    hideAll = vi.fn()
    destroy = vi.fn()
    state = vi.fn(() => [])
    owns = (wc: unknown) => this.owned.includes(wc)
    constructor() {
      h.tabs.push(this as unknown as (typeof h.tabs)[number])
    }
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
      const id = h.nextId++
      this.parentWindow = opts.parent
      this.parentWindowId = opts.parent.id
      this.popupWebContentsId = id
      this.popup = {
        webContents: { id, send: vi.fn(), focus: vi.fn(), isDestroyed: () => false },
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
  closeAppsOverlay,
  isAppsOverlayOpen,
  openAppsOverlay,
  raiseAppsOverlayIfOpen,
  registerAppsOverlayIpc,
  toggleAppsOverlay,
  _resetAppsOverlaysForTest
} from './appsOverlay'

const openTerminal = vi.fn()
registerAppsOverlayIpc({ openTerminal })

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

function fire(channel: string, id: number, ...args: unknown[]): void {
  h.onHandlers.get(channel)!({ sender: { id } }, ...args)
}

/** Open an overlay in a fresh window and mark its renderer ready. */
function openReady() {
  const win = fakeWindow()
  openAppsOverlay(win)
  const view = h.views.at(-1)!
  const tabs = h.tabs.at(-1)!
  fire('apps-overlay:ready', view.popupWebContentsId)
  return { win, view, tabs, id: view.popupWebContentsId }
}

beforeEach(() => {
  vi.useFakeTimers()
  h.views.length = 0
  h.tabs.length = 0
  h.focused = null
  openTerminal.mockClear()
})

afterEach(() => {
  _resetAppsOverlaysForTest()
  vi.useRealTimers()
})

describe('apps overlay lifecycle', () => {
  it('waits for the renderer, then shows below the title bar with copy and state', () => {
    const win = fakeWindow()
    openAppsOverlay(win)
    const view = h.views[0]!
    expect(view.showOnTop).not.toHaveBeenCalled()
    expect(isAppsOverlayOpen(win)).toBe(true)

    fire('apps-overlay:ready', view.popupWebContentsId)
    expect(view.showOnTop).toHaveBeenCalledWith({ focus: true })
    expect(view.popup.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 33, width: 1280, height: 767 })
    const sent = view.popup.webContents.send.mock.calls.map(([channel]) => channel)
    expect(sent).toEqual(['apps-overlay:show', 'apps-overlay:state'])
    const state = view.popup.webContents.send.mock.calls[1]![1]
    expect(state.apps.map((a: { name: string }) => a.name)).toEqual([
      'appsOverlay.appBrowser',
      'appsOverlay.appTerminal',
      'Docs'
    ])
    expect(h.tabs[0]!.layout).toHaveBeenCalled()
  })

  it('hides pages with the overlay and restores the previous focus', () => {
    const previous = { isDestroyed: () => false, focus: vi.fn() }
    h.focused = previous
    const { win, view, tabs } = openReady()
    toggleAppsOverlay(win)
    expect(isAppsOverlayOpen(win)).toBe(false)
    expect(tabs.hideAll).toHaveBeenCalled()
    expect(view.hide).toHaveBeenCalled()
    expect(previous.focus).toHaveBeenCalled()
    expect(tabs.destroy).not.toHaveBeenCalled()
  })

  it('does not return focus to one of its own pages', () => {
    const win = fakeWindow()
    openAppsOverlay(win)
    const tabs = h.tabs[0]!
    closeAppsOverlay(win)
    const page = { isDestroyed: () => false, focus: vi.fn() }
    tabs.owned.push(page)
    h.focused = page
    openAppsOverlay(win)
    fire('apps-overlay:ready', h.views[0]!.popupWebContentsId)
    closeAppsOverlay(win)
    expect(page.focus).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })

  it('cancels an open still waiting on the renderer', () => {
    const win = fakeWindow()
    openAppsOverlay(win)
    closeAppsOverlay(win)
    fire('apps-overlay:ready', h.views[0]!.popupWebContentsId)
    expect(h.views[0]!.showOnTop).not.toHaveBeenCalled()
  })

  it('re-raises only when open', () => {
    const win = fakeWindow()
    raiseAppsOverlayIfOpen(win)
    openAppsOverlay(win)
    raiseAppsOverlayIfOpen(win)
    expect(h.views[0]!.showOnTop).not.toHaveBeenCalled()
    fire('apps-overlay:ready', h.views[0]!.popupWebContentsId)
    raiseAppsOverlayIfOpen(win)
    expect(h.views[0]!.showOnTop).toHaveBeenCalledTimes(2)
  })
})

describe('apps overlay actions', () => {
  it('opens the browser at the home page and web apps at their URL', () => {
    const { tabs, id } = openReady()
    fire('apps-overlay:open-app', id, 'browser')
    fire('apps-overlay:open-app', id, 'web:docs')
    fire('apps-overlay:new-tab', id)
    expect(tabs.open.mock.calls).toEqual([
      ['https://home.example/'],
      ['https://docs.example/'],
      ['https://home.example/']
    ])
  })

  it('swaps itself for the terminal', () => {
    const { win, view, id } = openReady()
    fire('apps-overlay:open-app', id, 'terminal')
    expect(view.hide).toHaveBeenCalled()
    expect(openTerminal).toHaveBeenCalledWith(win)
  })

  it('resolves address-bar input before navigating', () => {
    const { tabs, id } = openReady()
    fire('apps-overlay:navigate', id, 7, 'localhost:8188')
    fire('apps-overlay:navigate', id, 7, 'flux loras')
    fire('apps-overlay:navigate', id, 7, 'file:///etc/passwd')
    expect(tabs.navigate.mock.calls).toEqual([
      [7, 'http://localhost:8188/'],
      [7, 'https://s.example/?q=flux%20loras']
    ])
  })

  it('handles browser shortcuts against the active tab', () => {
    const { view, tabs, id } = openReady()
    ;(tabs as unknown as { activeTabId: number }).activeTabId = 4
    fire('apps-overlay:shortcut', id, 'close-tab')
    fire('apps-overlay:shortcut', id, 'reload')
    fire('apps-overlay:shortcut', id, 'next-tab')
    fire('apps-overlay:shortcut', id, 'focus-address')
    fire('apps-overlay:shortcut', id, 'rm -rf')
    expect(tabs.close).toHaveBeenCalledWith(4)
    expect(tabs.reload).toHaveBeenCalledWith(4)
    expect(tabs.cycle).toHaveBeenCalledWith(1)
    expect(view.popup.webContents.send).toHaveBeenCalledWith('apps-overlay:focus-address')
  })

  it('shows a download notice in the window that owns the page, then clears it', () => {
    const a = openReady()
    const b = openReady()
    const page = {}
    a.tabs.owned.push(page)
    h.downloadListener!({ webContents: page, filename: 'x.zip', savedPath: '/d/x.zip' })
    const lastState = (view: typeof a.view) =>
      view.popup.webContents.send.mock.calls.filter(([c]) => c === 'apps-overlay:state').at(-1)![1]
    expect(lastState(a.view).notice).toBe('appsOverlay.downloaded:{"name":"x.zip"}')
    expect(lastState(b.view).notice).toBeNull()
    vi.advanceTimersByTime(6000)
    expect(lastState(a.view).notice).toBeNull()
  })
})

describe('apps overlay IPC scoping', () => {
  it('ignores senders that are not overlay renderers', () => {
    const { tabs } = openReady()
    const stranger = 9999
    fire('apps-overlay:open-app', stranger, 'browser')
    fire('apps-overlay:navigate', stranger, 1, 'https://evil.example/')
    fire('apps-overlay:close-tab', stranger, 1)
    fire('apps-overlay:content-rect', stranger, { x: 0, y: 0, width: 1, height: 1 })
    expect(tabs.open).not.toHaveBeenCalled()
    expect(tabs.navigate).not.toHaveBeenCalled()
    expect(tabs.close).not.toHaveBeenCalled()
    expect(tabs.setContentRect).not.toHaveBeenCalled()
  })

  it('rejects malformed payloads', () => {
    const { tabs, id } = openReady()
    fire('apps-overlay:close-tab', id, '1')
    fire('apps-overlay:close-tab', id, 1.5)
    fire('apps-overlay:navigate', id, 1, { url: 'x' })
    fire('apps-overlay:activate-tab', id, 'launcher')
    fire('apps-overlay:content-rect', id, { x: 0, y: 0, width: Number.NaN, height: 1 })
    fire('apps-overlay:open-app', id, 42)
    expect(tabs.close).not.toHaveBeenCalled()
    expect(tabs.navigate).not.toHaveBeenCalled()
    expect(tabs.activate).not.toHaveBeenCalled()
    expect(tabs.setContentRect).not.toHaveBeenCalled()
    expect(tabs.open).not.toHaveBeenCalled()

    fire('apps-overlay:activate-tab', id, null)
    fire('apps-overlay:content-rect', id, { x: 6, y: 90, width: 100, height: 50 })
    expect(tabs.activate).toHaveBeenCalledWith(null)
    expect(tabs.setContentRect).toHaveBeenCalledWith({ x: 6, y: 90, width: 100, height: 50 })
  })
})
