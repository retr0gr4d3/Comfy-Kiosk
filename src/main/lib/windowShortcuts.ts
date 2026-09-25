import { app, BrowserWindow, webContents as electronWebContents } from 'electron'
import type { Input, WebContents, WebContentsView } from 'electron'
import { comfyWindows } from '../host/registry'

/**
 * App-wide Ctrl+Alt+<letter> chords that act on the host window with focus:
 * Ctrl+Alt+T (system terminal) and Ctrl+Alt+A (apps launcher).
 *
 * Handled per webContents with `before-input-event` rather than
 * `globalShortcut` or a menu accelerator: a global shortcut is grabbed from
 * the compositor (and is unreliable on Wayland/cage), and a menu accelerator
 * only fires when the page doesn't consume the key first — xterm, the
 * ComfyUI canvas and browsed pages all may. `before-input-event` sees the key
 * before any page, in every view: title bar, body, popups, overlays and
 * contained browser tabs.
 */

type ChordInput = Pick<Input, 'type' | 'key' | 'code' | 'control' | 'alt' | 'shift' | 'meta'> & {
  isAutoRepeat?: boolean
}

/** Ctrl+Alt+`letter` (no Shift/Meta), on key-down, not auto-repeat. */
export function isCtrlAltChord(input: ChordInput, letter: string): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return false
  if (!input.control || !input.alt || input.shift || input.meta) return false
  // `code` is layout-independent (the physical key); `key` covers layouts
  // where the letter lives elsewhere.
  const upper = letter.toUpperCase()
  return input.code === `Key${upper}` || input.key.toUpperCase() === upper
}

/** The host window whose views include `wc`, else the focused host window. */
export function findHostWindowForWebContents(wc: WebContents): BrowserWindow | null {
  for (const entry of comfyWindows.values()) {
    const win = entry.window
    if (win.isDestroyed()) continue
    if (win.webContents === wc) return win
    const children = win.contentView.children as WebContentsView[]
    if (children.some((child) => child.webContents === wc)) return win
  }
  const focused = BrowserWindow.getFocusedWindow()
  if (!focused) return null
  for (const entry of comfyWindows.values()) {
    if (entry.window === focused) return focused
  }
  return null
}

export interface WindowShortcut {
  letter: string
  onTrigger(win: BrowserWindow): void
}

const hooked = new WeakSet<WebContents>()

function hook(wc: WebContents, shortcuts: readonly WindowShortcut[]): void {
  if (hooked.has(wc)) return
  hooked.add(wc)
  wc.on('before-input-event', (event, input) => {
    const shortcut = shortcuts.find((s) => isCtrlAltChord(input, s.letter))
    if (!shortcut) return
    const win = findHostWindowForWebContents(wc)
    if (!win) return
    event.preventDefault()
    shortcut.onTrigger(win)
  })
}

/** Hook every current and future webContents. Call once at app ready. */
export function installWindowShortcuts(shortcuts: readonly WindowShortcut[]): void {
  app.on('web-contents-created', (_event, wc) => hook(wc, shortcuts))
  for (const wc of electronWebContents.getAllWebContents()) hook(wc, shortcuts)
}
