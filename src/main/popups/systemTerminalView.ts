import { ipcMain, webContents as electronWebContents } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import { t } from '../lib/i18n'
import { TITLEBAR_HEIGHT } from '../lib/titleBarOverlay'
import {
  onSystemTerminalExit,
  resizeSystemTerminal,
  subscribeSystemTerminal,
  writeSystemTerminal
} from '../lib/systemTerminal'
import type { SystemTerminalRestore, SystemTerminalShowPayload } from '../../types/systemTerminal'
import { EmbeddedPopupView } from './embeddedPopupView'

/**
 * The in-window system terminal overlay (Ctrl+Alt+T).
 *
 * Under a kiosk compositor like cage every new top-level window is shown
 * fullscreen on top of the app, so a separate terminal window would replace
 * Comfy Desktop rather than sit inside it. Instead each host window gets one
 * transparent `WebContentsView` covering the body below the title bar; its
 * renderer draws the terminal as part of the app's own chrome. All overlays
 * view the same shell (`lib/systemTerminal.ts`).
 *
 * Lifecycle: the view is built on first open and reused. Opening shows it on
 * top and focuses it; closing asks the renderer to play its exit animation,
 * then hides the view and returns focus to whatever had it before.
 */

/** How long to wait for the renderer's exit-animation ack before hiding anyway. */
const HIDE_FALLBACK_MS = 300

export const SYSTEM_TERMINAL_CHANNELS = {
  ready: 'system-terminal:ready',
  show: 'system-terminal:show',
  hide: 'system-terminal:hide',
  hidden: 'system-terminal:hidden',
  requestClose: 'system-terminal:request-close',
  subscribe: 'system-terminal:subscribe',
  write: 'system-terminal:write',
  resize: 'system-terminal:resize'
} as const

interface OverlayEntry {
  view: EmbeddedPopupView
  /** Open was requested before the renderer finished loading; shown on `ready`. */
  pendingOpen: boolean
  /** Between a close request and the view actually hiding. */
  closing: boolean
  hideTimer: ReturnType<typeof setTimeout> | null
  /** What had keyboard focus before the overlay opened, restored on close. */
  returnFocus: WebContents | null
}

const overlaysByParent = new Map<number, OverlayEntry>()
const overlaysByWebContents = new Map<number, OverlayEntry>()

function layoutBelowTitleBar(entry: OverlayEntry): void {
  const { view } = entry
  if (view.isDestroyed()) return
  const b = view.parentWindow.getContentBounds()
  const y = TITLEBAR_HEIGHT + 1
  view.popup.setBounds({ x: 0, y, width: b.width, height: Math.max(1, b.height - y) })
}

function ensureOverlay(parent: BrowserWindow): OverlayEntry {
  const existing = overlaysByParent.get(parent.id)
  if (existing && !existing.view.isDestroyed()) return existing

  let entry: OverlayEntry | null = null
  const relayout = (): void => {
    if (entry) layoutBelowTitleBar(entry)
  }
  const forget = (view: EmbeddedPopupView): void => {
    if (!parent.isDestroyed()) parent.removeListener('resize', relayout)
    const cur = overlaysByParent.get(view.parentWindowId)
    if (cur && cur.view === view) {
      if (cur.hideTimer) clearTimeout(cur.hideTimer)
      overlaysByParent.delete(view.parentWindowId)
    }
    overlaysByWebContents.delete(view.popupWebContentsId)
  }

  const view: EmbeddedPopupView = new EmbeddedPopupView({
    parent,
    htmlName: 'systemTerminal',
    preloadName: 'systemTerminalPreload.js',
    initialBounds: { x: 0, y: 0, width: 1, height: 1 },
    onParentClosed: () => forget(view),
    onDestroyed: () => forget(view)
  })
  entry = { view, pendingOpen: false, closing: false, hideTimer: null, returnFocus: null }
  overlaysByParent.set(view.parentWindowId, entry)
  overlaysByWebContents.set(view.popupWebContentsId, entry)
  layoutBelowTitleBar(entry)
  parent.on('resize', relayout)
  return entry
}

/** Localized header copy, pushed with every show so a locale switch applies
 *  on the next open (the overlay renderer has no i18n loader of its own). */
function showPayload(): SystemTerminalShowPayload {
  return {
    title: t('systemTerminal.title'),
    hint: t('systemTerminal.hint'),
    close: t('systemTerminal.close')
  }
}

function showNow(entry: OverlayEntry): void {
  if (entry.view.isDestroyed()) return
  layoutBelowTitleBar(entry)
  entry.view.showOnTop({ focus: true })
  entry.view.popup.webContents.send(SYSTEM_TERMINAL_CHANNELS.show, showPayload())
}

function finishHide(entry: OverlayEntry): void {
  if (entry.hideTimer) {
    clearTimeout(entry.hideTimer)
    entry.hideTimer = null
  }
  if (!entry.closing) return
  entry.closing = false
  entry.view.hide()
  const target = entry.returnFocus
  entry.returnFocus = null
  if (entry.view.parentWindow.isDestroyed()) return
  if (target && !target.isDestroyed()) target.focus()
  else entry.view.parentWindow.focus()
}

/** True while the overlay for `parent` is visible (or animating in/out). */
export function isSystemTerminalOpen(parent: BrowserWindow): boolean {
  const entry = overlaysByParent.get(parent.id)
  if (!entry || entry.view.isDestroyed()) return false
  return entry.pendingOpen || (entry.view.isOpen && !entry.closing)
}

export function openSystemTerminal(parent: BrowserWindow): void {
  if (parent.isDestroyed()) return
  const entry = ensureOverlay(parent)
  if (entry.closing) {
    // Re-opened mid exit animation: cancel the hide and stay up.
    entry.closing = false
    if (entry.hideTimer) clearTimeout(entry.hideTimer)
    entry.hideTimer = null
    showNow(entry)
    return
  }
  if (entry.view.isOpen || entry.pendingOpen) return
  const focused = electronWebContents.getFocusedWebContents()
  entry.returnFocus = focused && focused !== entry.view.popup.webContents ? focused : null
  if (!entry.view.rendererReady) {
    entry.pendingOpen = true
    return
  }
  showNow(entry)
}

export function closeSystemTerminal(parent: BrowserWindow): void {
  const entry = overlaysByParent.get(parent.id)
  if (!entry || entry.view.isDestroyed()) return
  if (entry.pendingOpen) {
    entry.pendingOpen = false
    return
  }
  if (!entry.view.isOpen || entry.closing) return
  entry.closing = true
  entry.view.popup.webContents.send(SYSTEM_TERMINAL_CHANNELS.hide)
  entry.hideTimer = setTimeout(() => finishHide(entry), HIDE_FALLBACK_MS)
}

export function toggleSystemTerminal(parent: BrowserWindow): void {
  if (isSystemTerminalOpen(parent)) closeSystemTerminal(parent)
  else openSystemTerminal(parent)
}

/**
 * Keep an open overlay above views added to `parent` after it opened (a
 * lazily built panel, a rebuilt ComfyUI view). No-op when closed.
 */
export function raiseSystemTerminalIfOpen(parent: BrowserWindow): void {
  const entry = overlaysByParent.get(parent.id)
  if (!entry || entry.view.isDestroyed() || !entry.view.isOpen || entry.closing) return
  entry.view.showOnTop()
}

/** True when `wc` is a system terminal overlay's renderer. */
export function isSystemTerminalSender(wc: WebContents): boolean {
  return overlaysByWebContents.has(wc.id)
}

/** Wire the overlay IPC. Every channel is scoped to overlay renderers: no other
 *  view (least of all the served ComfyUI page) can reach the system shell. */
export function registerSystemTerminalIpc(): void {
  ipcMain.on(SYSTEM_TERMINAL_CHANNELS.ready, (event) => {
    const entry = overlaysByWebContents.get(event.sender.id)
    if (!entry) return
    entry.view.rendererReady = true
    if (entry.pendingOpen) {
      entry.pendingOpen = false
      showNow(entry)
    }
  })

  ipcMain.on(SYSTEM_TERMINAL_CHANNELS.hidden, (event) => {
    const entry = overlaysByWebContents.get(event.sender.id)
    if (entry) finishHide(entry)
  })

  ipcMain.on(SYSTEM_TERMINAL_CHANNELS.requestClose, (event) => {
    const entry = overlaysByWebContents.get(event.sender.id)
    if (entry) closeSystemTerminal(entry.view.parentWindow)
  })

  ipcMain.handle(
    SYSTEM_TERMINAL_CHANNELS.subscribe,
    async (event): Promise<SystemTerminalRestore | null> => {
      if (!overlaysByWebContents.has(event.sender.id)) return null
      return subscribeSystemTerminal(event.sender)
    }
  )

  ipcMain.on(SYSTEM_TERMINAL_CHANNELS.write, (event, data: unknown) => {
    if (!overlaysByWebContents.has(event.sender.id) || typeof data !== 'string') return
    writeSystemTerminal(data)
  })

  ipcMain.on(SYSTEM_TERMINAL_CHANNELS.resize, (event, cols: unknown, rows: unknown) => {
    if (!overlaysByWebContents.has(event.sender.id)) return
    if (typeof cols !== 'number' || typeof rows !== 'number') return
    resizeSystemTerminal(cols, rows)
  })

  // The shell ended on its own (`exit`): put every overlay away. The next
  // open spawns a fresh shell.
  onSystemTerminalExit(() => {
    for (const entry of overlaysByParent.values()) {
      if (!entry.view.isDestroyed()) closeSystemTerminal(entry.view.parentWindow)
    }
  })
}

/** Test-only: forget every overlay without touching Electron. */
export function _resetSystemTerminalOverlaysForTest(): void {
  for (const entry of overlaysByParent.values()) {
    if (entry.hideTimer) clearTimeout(entry.hideTimer)
  }
  overlaysByParent.clear()
  overlaysByWebContents.clear()
}
