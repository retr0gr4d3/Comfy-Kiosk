import type { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ views: [] as unknown[] }))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('events')
  class FakeWebContents extends EventEmitter {
    url = ''
    title = ''
    destroyed = false
    loading = false
    history = { back: false, forward: false }
    openHandler: ((d: { url: string }) => { action: string }) | null = null
    loadURL = vi.fn(async (url: string) => {
      this.url = url
    })
    reload = vi.fn()
    stop = vi.fn()
    focus = vi.fn()
    close = vi.fn(() => {
      this.destroyed = true
    })
    navigationHistory = {
      canGoBack: () => this.history.back,
      canGoForward: () => this.history.forward,
      goBack: vi.fn(),
      goForward: vi.fn()
    }
    setWindowOpenHandler(fn: (d: { url: string }) => { action: string }) {
      this.openHandler = fn
    }
    isDestroyed() {
      return this.destroyed
    }
    getURL() {
      return this.url
    }
    getTitle() {
      return this.title
    }
    isLoading() {
      return this.loading
    }
  }
  class WebContentsView {
    webContents = new FakeWebContents()
    visible = true
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    radius = 0
    setBackgroundColor = vi.fn()
    setBorderRadius = vi.fn((r: number) => {
      this.radius = r
    })
    setVisible = vi.fn((v: boolean) => {
      this.visible = v
    })
    setBounds = vi.fn((b: typeof this.bounds) => {
      this.bounds = b
    })
    constructor(public opts: unknown) {
      h.views.push(this)
    }
  }
  return {
    WebContentsView,
    Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
    clipboard: { writeText: vi.fn() }
  }
})
vi.mock('./containedBrowserSession', () => ({
  getContainedBrowserSession: () => 'contained-session'
}))

import { BrowserTabs, type BrowserTabsHost } from './browserTabs'

interface FakeView {
  opts: { webPreferences: Record<string, unknown> }
  webContents: EventEmitter & {
    url: string
    title: string
    loading: boolean
    history: { back: boolean; forward: boolean }
    openHandler: ((d: { url: string }) => { action: string }) | null
    loadURL: ReturnType<typeof vi.fn>
    reload: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    navigationHistory: { goBack: ReturnType<typeof vi.fn> }
  }
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  radius: number
}

const views = h.views as FakeView[]

function makeHost(shown = true) {
  const children: unknown[] = []
  const host = {
    shown,
    parent: {
      isDestroyed: () => false,
      getContentBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
      contentView: {
        children,
        addChildView: vi.fn((v: unknown) => {
          const i = children.indexOf(v)
          if (i !== -1) children.splice(i, 1)
          children.push(v)
        }),
        removeChildView: vi.fn((v: unknown) => {
          const i = children.indexOf(v)
          if (i !== -1) children.splice(i, 1)
        })
      }
    },
    overlayOrigin: () => ({ x: 0, y: 33 }),
    isShown: () => host.shown,
    onChange: vi.fn(),
    onShortcut: vi.fn()
  }
  return host
}

function setup(shown = true) {
  const host = makeHost(shown)
  const tabs = new BrowserTabs(host as unknown as BrowserTabsHost)
  tabs.setContentRect({ x: 6, y: 90.4, width: 1250, height: 690 })
  return { host, tabs }
}

beforeEach(() => {
  views.length = 0
})

describe('BrowserTabs', () => {
  it('opens pages in sandboxed views on the contained session', () => {
    const { tabs } = setup()
    tabs.open('https://a.example/')
    expect(views[0]!.opts.webPreferences).toMatchObject({
      session: 'contained-session',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    })
    expect(views[0]!.opts.webPreferences).not.toHaveProperty('preload')
    expect(views[0]!.webContents.loadURL).toHaveBeenCalledWith('https://a.example/')
  })

  it('shows the active page over the reported area, above the overlay', () => {
    const { host, tabs } = setup()
    const id = tabs.open('https://a.example/')
    expect(tabs.activeTabId).toBe(id)
    expect(views[0]!.visible).toBe(true)
    expect(views[0]!.bounds).toEqual({ x: 6, y: 123, width: 1250, height: 690 })
    expect(host.parent.contentView.children.at(-1)).toBe(views[0])
    expect(host.onChange).toHaveBeenCalled()
  })

  it('keeps pages hidden while the overlay is hidden', () => {
    const { host, tabs } = setup(false)
    tabs.open('https://a.example/')
    expect(views[0]!.visible).toBe(false)
    host.shown = true
    tabs.layout()
    expect(views[0]!.visible).toBe(true)
    tabs.hideAll()
    expect(views[0]!.visible).toBe(false)
  })

  it('refuses URLs a tab may not load', () => {
    const { tabs } = setup()
    expect(tabs.open('file:///etc/passwd')).toBeNull()
    expect(views).toHaveLength(0)
  })

  it('shows only the active tab, and nothing on the launcher', () => {
    const { tabs } = setup()
    const a = tabs.open('https://a.example/')!
    tabs.open('https://b.example/')
    expect(views.map((v) => v.visible)).toEqual([false, true])
    tabs.activate(a)
    expect(views.map((v) => v.visible)).toEqual([true, false])
    tabs.activate(null)
    expect(views.map((v) => v.visible)).toEqual([false, false])
  })

  it('closing the active tab activates its neighbour, then the launcher', () => {
    const { host, tabs } = setup()
    const a = tabs.open('https://a.example/')!
    const b = tabs.open('https://b.example/')!
    tabs.close(b)
    expect(tabs.activeTabId).toBe(a)
    expect(views[1]!.webContents.close).toHaveBeenCalled()
    expect(host.parent.contentView.children).not.toContain(views[1])
    tabs.close(a)
    expect(tabs.activeTabId).toBeNull()
    expect(tabs.tabIds).toEqual([])
  })

  it('cycles through tabs with wrap-around', () => {
    const { tabs } = setup()
    const a = tabs.open('https://a.example/')!
    const b = tabs.open('https://b.example/')!
    tabs.cycle(1)
    expect(tabs.activeTabId).toBe(a)
    tabs.cycle(-1)
    expect(tabs.activeTabId).toBe(b)
  })

  it('turns popups into tabs and never lets a page open a window', () => {
    const { tabs } = setup()
    tabs.open('https://a.example/')
    const handler = views[0]!.webContents.openHandler!
    expect(handler({ url: 'https://b.example/' })).toEqual({ action: 'deny' })
    expect(tabs.tabIds).toHaveLength(2)
    expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'about:blank' })).toEqual({ action: 'deny' })
    expect(tabs.tabIds).toHaveLength(2)
  })

  it('blocks navigation to refused schemes', () => {
    const { tabs } = setup()
    tabs.open('https://a.example/')
    for (const event of ['will-navigate', 'will-redirect']) {
      const refused = { preventDefault: vi.fn() }
      views[0]!.webContents.emit(event, refused, 'file:///etc/passwd')
      expect(refused.preventDefault).toHaveBeenCalled()
      const allowed = { preventDefault: vi.fn() }
      views[0]!.webContents.emit(event, allowed, 'https://c.example/')
      expect(allowed.preventDefault).not.toHaveBeenCalled()
    }
  })

  it('hides a page whose main frame failed to load, until the next navigation', () => {
    const { tabs } = setup()
    tabs.open('https://a.example/')
    const wc = views[0]!.webContents
    wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://a.example/', true)
    wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x.example/', false)
    expect(tabs.state()[0]!.error).toBeNull()

    wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'https://a.example/', true)
    expect(tabs.state()[0]!.error).toBe('ERR_CONNECTION_REFUSED')
    expect(views[0]!.visible).toBe(false)

    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(tabs.state()[0]!.error).toBeNull()
    expect(views[0]!.visible).toBe(true)
  })

  it('covers the whole window while a page is fullscreen', () => {
    const { tabs } = setup()
    tabs.open('https://a.example/')
    views[0]!.webContents.emit('enter-html-full-screen')
    expect(views[0]!.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
    expect(views[0]!.radius).toBe(0)
    views[0]!.webContents.emit('leave-html-full-screen')
    expect(views[0]!.bounds).toEqual({ x: 6, y: 123, width: 1250, height: 690 })
    expect(views[0]!.radius).toBeGreaterThan(0)
  })

  it('routes browser shortcuts pressed in a page to the host', () => {
    const { host, tabs } = setup()
    tabs.open('https://a.example/')
    const event = { preventDefault: vi.fn() }
    views[0]!.webContents.emit('before-input-event', event, {
      type: 'keyDown',
      key: 'l',
      control: true,
      alt: false,
      shift: false,
      meta: false
    })
    expect(event.preventDefault).toHaveBeenCalled()
    expect(host.onShortcut).toHaveBeenCalledWith('focus-address')

    const plain = { preventDefault: vi.fn() }
    views[0]!.webContents.emit('before-input-event', plain, {
      type: 'keyDown',
      key: 'l',
      control: false,
      alt: false,
      shift: false,
      meta: false
    })
    expect(plain.preventDefault).not.toHaveBeenCalled()
  })

  it('reports tab state for the chrome', () => {
    const { tabs } = setup()
    const id = tabs.open('https://a.example/')!
    const wc = views[0]!.webContents
    wc.title = 'A'
    wc.loading = true
    wc.history.back = true
    expect(tabs.state()).toEqual([
      {
        id,
        title: 'A',
        url: 'https://a.example/',
        loading: true,
        canGoBack: true,
        canGoForward: false,
        error: null
      }
    ])
  })

  it('navigates, reloads and goes back only on known tabs with allowed URLs', () => {
    const { tabs } = setup()
    const id = tabs.open('https://a.example/')!
    const wc = views[0]!.webContents
    tabs.navigate(id, 'javascript:alert(1)')
    tabs.navigate(999, 'https://b.example/')
    expect(wc.loadURL).toHaveBeenCalledTimes(1)
    tabs.navigate(id, 'https://b.example/')
    expect(wc.loadURL).toHaveBeenLastCalledWith('https://b.example/')
    tabs.back(id)
    expect(wc.navigationHistory.goBack).not.toHaveBeenCalled()
    wc.history.back = true
    tabs.back(id)
    expect(wc.navigationHistory.goBack).toHaveBeenCalledTimes(1)
    tabs.reload(id)
    expect(wc.reload).toHaveBeenCalled()
  })

  it('destroys every page', () => {
    const { tabs } = setup()
    tabs.open('https://a.example/')
    tabs.open('https://b.example/')
    tabs.destroy()
    expect(views.every((v) => v.webContents.close.mock.calls.length === 1)).toBe(true)
    expect(tabs.activeTabId).toBeNull()
  })
})
