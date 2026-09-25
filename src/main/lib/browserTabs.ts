import { Menu, WebContentsView, clipboard } from 'electron'
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from 'electron'
import type { BrowserTabState, ContentRect } from '../../types/appsOverlay'
import { isNavigableUrl } from '../../shared/browserUrl'
import { matchBrowserShortcut, type BrowserShortcut } from '../../shared/browserShortcuts'
import { getContainedBrowserSession } from './containedBrowserSession'

/**
 * The contained browser's tabs for one host window.
 *
 * Each tab is a sandboxed `WebContentsView` on the contained session, added
 * to the host window and positioned over the page area the apps overlay
 * renderer reports. Pages never get a preload or Node access, can only load
 * http(s), and every popup they open becomes another tab here instead of a
 * separate window (which a kiosk compositor would put over the whole app).
 */

export interface BrowserTabsHost {
  parent: BrowserWindow
  /** Top-left of the overlay view in the window's content coordinates. */
  overlayOrigin(): { x: number; y: number }
  /** True while the apps overlay is visible, so pages may be shown. */
  isShown(): boolean
  /** Tab list, titles, URLs or loading state changed. */
  onChange(): void
  /** A browser shortcut was pressed inside a page. */
  onShortcut(action: BrowserShortcut): void
}

interface Tab {
  id: number
  view: WebContentsView
  error: string | null
  fullscreen: boolean
}

let nextTabId = 1
const PAGE_RADIUS = 8

export class BrowserTabs {
  readonly #host: BrowserTabsHost
  readonly #tabs: Tab[] = []
  #activeId: number | null = null
  #rect: ContentRect | null = null

  constructor(host: BrowserTabsHost) {
    this.#host = host
  }

  get activeTabId(): number | null {
    return this.#activeId
  }

  get tabIds(): number[] {
    return this.#tabs.map((t) => t.id)
  }

  owns(wc: Electron.WebContents): boolean {
    return this.#tabs.some((t) => t.view.webContents === wc)
  }

  /** Open `url` in a new tab and make it active. Returns the tab id. */
  open(url: string): number | null {
    if (!isNavigableUrl(url) || this.#host.parent.isDestroyed()) return null
    const view = new WebContentsView({
      webPreferences: {
        session: getContainedBrowserSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false
      }
    })
    view.setBackgroundColor('#ffffff')
    // Matches the page slot in the overlay so the page reads as a card in the sheet.
    view.setBorderRadius(PAGE_RADIUS)
    view.setVisible(false)
    this.#host.parent.contentView.addChildView(view)
    const tab: Tab = { id: nextTabId++, view, error: null, fullscreen: false }
    this.#tabs.push(tab)
    this.#wire(tab)
    this.#activeId = tab.id
    void view.webContents.loadURL(url).catch(() => {
      // did-fail-load records the error for the page.
    })
    this.layout()
    this.#host.onChange()
    return tab.id
  }

  close(id: number): void {
    const index = this.#tabs.findIndex((t) => t.id === id)
    if (index === -1) return
    const [tab] = this.#tabs.splice(index, 1)
    this.#destroyView(tab!)
    if (this.#activeId === id) {
      const next = this.#tabs[Math.min(index, this.#tabs.length - 1)]
      this.#activeId = next ? next.id : null
    }
    this.layout()
    this.#host.onChange()
  }

  /** Make a tab active, or pass `null` to show the launcher. */
  activate(id: number | null): void {
    if (id !== null && !this.#find(id)) return
    this.#activeId = id
    this.layout()
    this.#host.onChange()
  }

  /** Step through tabs; wraps around. */
  cycle(step: 1 | -1): void {
    if (this.#tabs.length === 0) return
    const index = this.#tabs.findIndex((t) => t.id === this.#activeId)
    const next = (index + step + this.#tabs.length) % this.#tabs.length
    this.activate(this.#tabs[index === -1 ? 0 : next]!.id)
  }

  navigate(id: number, url: string): void {
    const tab = this.#find(id)
    if (!tab || !isNavigableUrl(url)) return
    tab.error = null
    void tab.view.webContents.loadURL(url).catch(() => {})
    this.layout()
    this.#host.onChange()
  }

  back(id: number): void {
    const history = this.#find(id)?.view.webContents.navigationHistory
    if (history?.canGoBack()) history.goBack()
  }

  forward(id: number): void {
    const history = this.#find(id)?.view.webContents.navigationHistory
    if (history?.canGoForward()) history.goForward()
  }

  reload(id: number): void {
    const tab = this.#find(id)
    if (!tab) return
    tab.error = null
    tab.view.webContents.reload()
    this.layout()
    this.#host.onChange()
  }

  stop(id: number): void {
    this.#find(id)?.view.webContents.stop()
  }

  focusActive(): void {
    const tab = this.#activeTab()
    if (tab && !tab.error) tab.view.webContents.focus()
  }

  setContentRect(rect: ContentRect): void {
    this.#rect = rect
    this.layout()
  }

  /** Show the active page over the reported page area (or the whole window
   *  while it is fullscreen) on top of the overlay; hide every other page. */
  layout(): void {
    if (this.#host.parent.isDestroyed()) return
    const active = this.#activeTab()
    for (const tab of this.#tabs) {
      if (tab !== active) tab.view.setVisible(false)
    }
    if (!active) return
    const rect = this.#rect
    const showable =
      this.#host.isShown() && !active.error && rect !== null && rect.width > 0 && rect.height > 0
    if (!showable) {
      active.view.setVisible(false)
      return
    }
    if (active.fullscreen) {
      const b = this.#host.parent.getContentBounds()
      active.view.setBorderRadius(0)
      active.view.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
    } else {
      active.view.setBorderRadius(PAGE_RADIUS)
      const origin = this.#host.overlayOrigin()
      active.view.setBounds({
        x: Math.round(origin.x + rect.x),
        y: Math.round(origin.y + rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      })
    }
    // Re-adding moves the page to the top, above the overlay it sits in.
    this.#host.parent.contentView.addChildView(active.view)
    active.view.setVisible(true)
  }

  hideAll(): void {
    for (const tab of this.#tabs) tab.view.setVisible(false)
  }

  state(): BrowserTabState[] {
    return this.#tabs.map((tab) => {
      const wc = tab.view.webContents
      if (wc.isDestroyed()) {
        return {
          id: tab.id,
          title: '',
          url: '',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          error: tab.error
        }
      }
      return {
        id: tab.id,
        title: wc.getTitle(),
        url: wc.getURL(),
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        error: tab.error
      }
    })
  }

  destroy(): void {
    for (const tab of this.#tabs.splice(0)) this.#destroyView(tab)
    this.#activeId = null
  }

  #find(id: number): Tab | undefined {
    return this.#tabs.find((t) => t.id === id)
  }

  #activeTab(): Tab | undefined {
    return this.#activeId === null ? undefined : this.#find(this.#activeId)
  }

  #destroyView(tab: Tab): void {
    if (!this.#host.parent.isDestroyed()) {
      try {
        this.#host.parent.contentView.removeChildView(tab.view)
      } catch {
        // Already detached.
      }
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
  }

  #wire(tab: Tab): void {
    const wc = tab.view.webContents
    const changed = (): void => this.#host.onChange()

    // Popups and target=_blank links become tabs here.
    wc.setWindowOpenHandler(({ url }) => {
      if (isNavigableUrl(url) && url !== 'about:blank') this.open(url)
      return { action: 'deny' }
    })
    const guard = (event: Electron.Event, url: string): void => {
      if (!isNavigableUrl(url)) event.preventDefault()
    }
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)

    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument || !tab.error) return
      tab.error = null
      this.layout()
      changed()
    })
    wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      // -3 is ERR_ABORTED: a navigation replaced by another, not a failure.
      if (!isMainFrame || code === -3) return
      tab.error = description || `Error ${code}`
      this.layout()
      changed()
    })
    wc.on('render-process-gone', () => {
      tab.error = 'crashed'
      this.layout()
      changed()
    })
    for (const event of [
      'page-title-updated',
      'did-navigate',
      'did-navigate-in-page',
      'did-start-loading',
      'did-stop-loading'
    ] as const) {
      wc.on(event as 'did-stop-loading', changed)
    }

    wc.on('enter-html-full-screen', () => {
      tab.fullscreen = true
      this.layout()
    })
    wc.on('leave-html-full-screen', () => {
      tab.fullscreen = false
      this.layout()
    })

    wc.on('before-input-event', (event, input) => {
      const action = matchBrowserShortcut(input)
      if (!action) return
      event.preventDefault()
      this.#host.onShortcut(action)
    })

    wc.on('context-menu', (_e, params) => {
      Menu.buildFromTemplate(this.#contextMenu(tab, params)).popup({
        window: this.#host.parent
      })
    })
  }

  #contextMenu(tab: Tab, params: ContextMenuParams): MenuItemConstructorOptions[] {
    const wc = tab.view.webContents
    const items: MenuItemConstructorOptions[] = []
    if (params.linkURL && isNavigableUrl(params.linkURL)) {
      items.push(
        { label: 'Open Link in New Tab', click: () => this.open(params.linkURL) },
        { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      )
    }
    if (params.isEditable) {
      items.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' }
      )
    } else if (params.selectionText) {
      items.push({ role: 'copy' })
    } else {
      items.push(
        {
          label: 'Back',
          enabled: wc.navigationHistory.canGoBack(),
          click: () => this.back(tab.id)
        },
        {
          label: 'Forward',
          enabled: wc.navigationHistory.canGoForward(),
          click: () => this.forward(tab.id)
        },
        { label: 'Reload', click: () => this.reload(tab.id) }
      )
    }
    return items
  }
}
