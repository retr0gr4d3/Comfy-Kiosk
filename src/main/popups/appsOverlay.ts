import { ipcMain, webContents as electronWebContents } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import type {
  AppEntry,
  AppsOverlayState,
  AppsOverlayStrings,
  ContentRect
} from '../../types/appsOverlay'
import type { BrowserShortcut } from '../../shared/browserShortcuts'
import { resolveAddressInput } from '../../shared/browserUrl'
import { loadAppsConfig, type AppsConfig } from '../lib/appsConfig'
import { BrowserTabs } from '../lib/browserTabs'
import { setContainedDownloadListener } from '../lib/containedBrowserSession'
import { t } from '../lib/i18n'
import { TITLEBAR_HEIGHT } from '../lib/titleBarOverlay'
import { EmbeddedPopupView } from './embeddedPopupView'

/**
 * The in-window apps overlay (Ctrl+Alt+A, or the title bar's Apps button):
 * a launcher grid plus a tabbed, contained browser.
 *
 * Like the system terminal, it is a transparent `WebContentsView` over the
 * host window's body, because under a kiosk compositor any separate window
 * would cover the whole app. Its renderer draws the chrome (tab strip,
 * toolbar, launcher); the pages themselves are separate sandboxed views
 * (`lib/browserTabs.ts`) positioned over the page area the renderer reports.
 *
 * Tabs belong to the window and outlive the overlay: hiding it hides the
 * pages but keeps them loaded, so reopening returns to where the user was.
 */

const NOTICE_MS = 6000

export const APPS_OVERLAY_CHANNELS = {
  ready: 'apps-overlay:ready',
  requestClose: 'apps-overlay:request-close',
  openApp: 'apps-overlay:open-app',
  newTab: 'apps-overlay:new-tab',
  activateTab: 'apps-overlay:activate-tab',
  closeTab: 'apps-overlay:close-tab',
  navigate: 'apps-overlay:navigate',
  back: 'apps-overlay:back',
  forward: 'apps-overlay:forward',
  reload: 'apps-overlay:reload',
  stop: 'apps-overlay:stop',
  shortcut: 'apps-overlay:shortcut',
  focusPage: 'apps-overlay:focus-page',
  contentRect: 'apps-overlay:content-rect',
  show: 'apps-overlay:show',
  state: 'apps-overlay:state',
  focusAddress: 'apps-overlay:focus-address'
} as const

export interface AppsOverlayDeps {
  /** Opens the system terminal in `parent` (the launcher's Terminal tile). */
  openTerminal(parent: BrowserWindow): void
}

interface OverlayEntry {
  view: EmbeddedPopupView
  tabs: BrowserTabs
  config: AppsConfig
  pendingOpen: boolean
  returnFocus: WebContents | null
  notice: string | null
  noticeTimer: ReturnType<typeof setTimeout> | null
}

const overlaysByParent = new Map<number, OverlayEntry>()
const overlaysByWebContents = new Map<number, OverlayEntry>()
let deps: AppsOverlayDeps = { openTerminal: () => {} }

function overlayBounds(parent: BrowserWindow): Electron.Rectangle {
  const b = parent.getContentBounds()
  const y = TITLEBAR_HEIGHT + 1
  return { x: 0, y, width: b.width, height: Math.max(1, b.height - y) }
}

function isShown(entry: OverlayEntry): boolean {
  return entry.view.isOpen && !entry.view.isDestroyed()
}

function strings(): AppsOverlayStrings {
  return {
    title: t('appsOverlay.title'),
    hint: t('appsOverlay.hint'),
    close: t('appsOverlay.close'),
    newTab: t('appsOverlay.newTab'),
    closeTab: t('appsOverlay.closeTab'),
    back: t('appsOverlay.back'),
    forward: t('appsOverlay.forward'),
    reload: t('appsOverlay.reload'),
    stop: t('appsOverlay.stop'),
    addressPlaceholder: t('appsOverlay.addressPlaceholder'),
    loadFailed: t('appsOverlay.loadFailed'),
    retry: t('appsOverlay.retry'),
    launcherHeading: t('appsOverlay.launcherHeading'),
    untitled: t('appsOverlay.untitled')
  }
}

function localizedApps(apps: AppEntry[]): AppEntry[] {
  return apps.map((app) => {
    if (app.kind === 'browser') return { ...app, name: t('appsOverlay.appBrowser') }
    if (app.kind === 'terminal') return { ...app, name: t('appsOverlay.appTerminal') }
    return app
  })
}

export function buildAppsOverlayState(entry: OverlayEntry): AppsOverlayState {
  return {
    apps: localizedApps(entry.config.apps),
    tabs: entry.tabs.state(),
    activeTabId: entry.tabs.activeTabId,
    notice: entry.notice,
    searchTemplate: entry.config.searchTemplate
  }
}

function pushState(entry: OverlayEntry): void {
  const wc = entry.view.popup.webContents
  if (wc.isDestroyed() || !entry.view.rendererReady) return
  wc.send(APPS_OVERLAY_CHANNELS.state, buildAppsOverlayState(entry))
}

function ensureOverlay(parent: BrowserWindow): OverlayEntry {
  const existing = overlaysByParent.get(parent.id)
  if (existing && !existing.view.isDestroyed()) return existing

  let entry: OverlayEntry | null = null
  const relayout = (): void => {
    if (!entry || entry.view.isDestroyed()) return
    entry.view.popup.setBounds(overlayBounds(parent))
    entry.tabs.layout()
  }
  const forget = (view: EmbeddedPopupView): void => {
    if (!parent.isDestroyed()) parent.removeListener('resize', relayout)
    const cur = overlaysByParent.get(view.parentWindowId)
    if (cur && cur.view === view) {
      if (cur.noticeTimer) clearTimeout(cur.noticeTimer)
      cur.tabs.destroy()
      overlaysByParent.delete(view.parentWindowId)
    }
    overlaysByWebContents.delete(view.popupWebContentsId)
  }

  const view: EmbeddedPopupView = new EmbeddedPopupView({
    parent,
    htmlName: 'appsOverlay',
    preloadName: 'appsOverlayPreload.js',
    initialBounds: overlayBounds(parent),
    onParentClosed: () => forget(view),
    onDestroyed: () => forget(view)
  })
  const created: OverlayEntry = {
    view,
    config: loadAppsConfig(),
    pendingOpen: false,
    returnFocus: null,
    notice: null,
    noticeTimer: null,
    tabs: new BrowserTabs({
      parent,
      overlayOrigin: () => {
        const b = overlayBounds(parent)
        return { x: b.x, y: b.y }
      },
      isShown: () => isShown(created),
      onChange: () => pushState(created),
      onShortcut: (action) => handleShortcut(created, action)
    })
  }
  entry = created
  overlaysByParent.set(view.parentWindowId, created)
  overlaysByWebContents.set(view.popupWebContentsId, created)
  parent.on('resize', relayout)
  return created
}

function showNow(entry: OverlayEntry): void {
  if (entry.view.isDestroyed()) return
  entry.view.popup.setBounds(overlayBounds(entry.view.parentWindow))
  entry.view.showOnTop({ focus: true })
  const wc = entry.view.popup.webContents
  wc.send(APPS_OVERLAY_CHANNELS.show, strings())
  pushState(entry)
  entry.tabs.layout()
  entry.tabs.focusActive()
}

export function isAppsOverlayOpen(parent: BrowserWindow): boolean {
  const entry = overlaysByParent.get(parent.id)
  if (!entry || entry.view.isDestroyed()) return false
  return entry.pendingOpen || entry.view.isOpen
}

export function openAppsOverlay(parent: BrowserWindow): void {
  if (parent.isDestroyed()) return
  const entry = ensureOverlay(parent)
  if (entry.view.isOpen || entry.pendingOpen) return
  // Re-read on every open so edits to apps.json apply without a restart.
  entry.config = loadAppsConfig()
  const focused = electronWebContents.getFocusedWebContents()
  entry.returnFocus =
    focused && focused !== entry.view.popup.webContents && !entry.tabs.owns(focused)
      ? focused
      : null
  if (!entry.view.rendererReady) {
    entry.pendingOpen = true
    return
  }
  showNow(entry)
}

export function closeAppsOverlay(parent: BrowserWindow): void {
  const entry = overlaysByParent.get(parent.id)
  if (!entry || entry.view.isDestroyed()) return
  if (entry.pendingOpen) {
    entry.pendingOpen = false
    return
  }
  if (!entry.view.isOpen) return
  entry.tabs.hideAll()
  entry.view.hide()
  const target = entry.returnFocus
  entry.returnFocus = null
  if (parent.isDestroyed()) return
  if (target && !target.isDestroyed()) target.focus()
  else parent.focus()
}

export function toggleAppsOverlay(parent: BrowserWindow): void {
  if (isAppsOverlayOpen(parent)) closeAppsOverlay(parent)
  else openAppsOverlay(parent)
}

/** Keep an open overlay (and its page) above views added after it opened. */
export function raiseAppsOverlayIfOpen(parent: BrowserWindow): void {
  const entry = overlaysByParent.get(parent.id)
  if (!entry || entry.view.isDestroyed() || !entry.view.isOpen) return
  entry.view.showOnTop()
  entry.tabs.layout()
}

function openApp(entry: OverlayEntry, appId: string): void {
  const app = entry.config.apps.find((a) => a.id === appId)
  if (!app) return
  const parent = entry.view.parentWindow
  switch (app.kind) {
    case 'browser':
      entry.tabs.open(entry.config.homeUrl)
      break
    case 'web':
      if (app.url) entry.tabs.open(app.url)
      break
    case 'terminal':
      closeAppsOverlay(parent)
      deps.openTerminal(parent)
      break
  }
}

function handleShortcut(entry: OverlayEntry, action: BrowserShortcut): void {
  const active = entry.tabs.activeTabId
  switch (action) {
    case 'focus-address':
      if (active === null) return
      entry.view.popup.webContents.focus()
      entry.view.popup.webContents.send(APPS_OVERLAY_CHANNELS.focusAddress)
      return
    case 'new-tab':
      entry.tabs.open(entry.config.homeUrl)
      entry.view.popup.webContents.focus()
      entry.view.popup.webContents.send(APPS_OVERLAY_CHANNELS.focusAddress)
      return
    case 'close-tab':
      if (active !== null) entry.tabs.close(active)
      return
    case 'reload':
      if (active !== null) entry.tabs.reload(active)
      return
    case 'back':
      if (active !== null) entry.tabs.back(active)
      return
    case 'forward':
      if (active !== null) entry.tabs.forward(active)
      return
    case 'next-tab':
      entry.tabs.cycle(1)
      return
    case 'previous-tab':
      entry.tabs.cycle(-1)
      return
  }
}

function setNotice(entry: OverlayEntry, notice: string): void {
  entry.notice = notice
  if (entry.noticeTimer) clearTimeout(entry.noticeTimer)
  entry.noticeTimer = setTimeout(() => {
    entry.notice = null
    entry.noticeTimer = null
    pushState(entry)
  }, NOTICE_MS)
  pushState(entry)
}

function isContentRect(value: unknown): value is ContentRect {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(
    (k) => typeof r[k] === 'number' && Number.isFinite(r[k] as number)
  )
}

const BROWSER_SHORTCUTS: ReadonlySet<string> = new Set([
  'focus-address',
  'new-tab',
  'close-tab',
  'reload',
  'back',
  'forward',
  'next-tab',
  'previous-tab'
])

/** Wire the overlay IPC. Every channel is scoped to overlay renderers. */
export function registerAppsOverlayIpc(injected: AppsOverlayDeps): void {
  deps = injected
  const on = (
    channel: string,
    handler: (entry: OverlayEntry, ...args: unknown[]) => void
  ): void => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      const entry = overlaysByWebContents.get(event.sender.id)
      if (entry && !entry.view.isDestroyed()) handler(entry, ...args)
    })
  }
  const tabId = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) ? value : null

  on(APPS_OVERLAY_CHANNELS.ready, (entry) => {
    entry.view.rendererReady = true
    if (entry.pendingOpen) {
      entry.pendingOpen = false
      showNow(entry)
    }
  })
  on(APPS_OVERLAY_CHANNELS.requestClose, (entry) => closeAppsOverlay(entry.view.parentWindow))
  on(APPS_OVERLAY_CHANNELS.openApp, (entry, appId) => {
    if (typeof appId === 'string') openApp(entry, appId)
  })
  on(APPS_OVERLAY_CHANNELS.newTab, (entry) => entry.tabs.open(entry.config.homeUrl))
  on(APPS_OVERLAY_CHANNELS.activateTab, (entry, id) => {
    if (id === null || tabId(id) !== null) entry.tabs.activate(id as number | null)
  })
  on(APPS_OVERLAY_CHANNELS.closeTab, (entry, id) => {
    const tid = tabId(id)
    if (tid !== null) entry.tabs.close(tid)
  })
  on(APPS_OVERLAY_CHANNELS.navigate, (entry, id, input) => {
    const tid = tabId(id)
    if (tid === null || typeof input !== 'string') return
    const url = resolveAddressInput(input, entry.config.searchTemplate)
    if (!url) return
    entry.tabs.navigate(tid, url)
    entry.tabs.focusActive()
  })
  for (const [channel, act] of [
    [APPS_OVERLAY_CHANNELS.back, 'back'],
    [APPS_OVERLAY_CHANNELS.forward, 'forward'],
    [APPS_OVERLAY_CHANNELS.reload, 'reload'],
    [APPS_OVERLAY_CHANNELS.stop, 'stop']
  ] as const) {
    on(channel, (entry, id) => {
      const tid = tabId(id)
      if (tid !== null) entry.tabs[act](tid)
    })
  }
  on(APPS_OVERLAY_CHANNELS.shortcut, (entry, action) => {
    if (typeof action === 'string' && BROWSER_SHORTCUTS.has(action)) {
      handleShortcut(entry, action as BrowserShortcut)
    }
  })
  on(APPS_OVERLAY_CHANNELS.focusPage, (entry) => entry.tabs.focusActive())
  on(APPS_OVERLAY_CHANNELS.contentRect, (entry, rect) => {
    if (isContentRect(rect)) entry.tabs.setContentRect(rect)
  })

  setContainedDownloadListener(({ webContents, filename, savedPath }) => {
    for (const entry of overlaysByParent.values()) {
      if (!entry.tabs.owns(webContents)) continue
      setNotice(
        entry,
        savedPath
          ? t('appsOverlay.downloaded', { name: filename })
          : t('appsOverlay.downloadFailed', { name: filename })
      )
    }
  })
}

/** Test-only: forget every overlay without touching Electron. */
export function _resetAppsOverlaysForTest(): void {
  for (const entry of overlaysByParent.values()) {
    if (entry.noticeTimer) clearTimeout(entry.noticeTimer)
  }
  overlaysByParent.clear()
  overlaysByWebContents.clear()
}
