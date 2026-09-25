import { app, BrowserWindow, webContents as electronWebContents } from 'electron'
import type { Input, WebContents, WebContentsView } from 'electron'
import { comfyWindows } from '../host/registry'

/**
 * Ctrl+Alt+T toggles the system terminal overlay in the host window that has
 * focus.
 *
 * Handled per webContents with `before-input-event` rather than
 * `globalShortcut` or a menu accelerator: a global shortcut is grabbed from
 * the compositor (and is unreliable on Wayland/cage), and a menu accelerator
 * only fires when the page doesn't consume the key first — xterm and the
 * ComfyUI canvas both do. `before-input-event` sees the key before any page,
 * in every view: title bar, body, popups and the terminal itself.
 */

type ShortcutInput = Pick<Input, 'type' | 'key' | 'code' | 'control' | 'alt' | 'shift' | 'meta'> & {
  isAutoRepeat?: boolean
}

export function isSystemTerminalShortcut(input: ShortcutInput): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return false
  if (!input.control || !input.alt || input.shift || input.meta) return false
  // `code` is layout-independent (the physical T key); `key` covers layouts
  // where the letter T lives elsewhere.
  return input.code === 'KeyT' || input.key.toLowerCase() === 't'
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

const hooked = new WeakSet<WebContents>()

function hook(wc: WebContents, onToggle: (win: BrowserWindow) => void): void {
  if (hooked.has(wc)) return
  hooked.add(wc)
  wc.on('before-input-event', (event, input) => {
    if (!isSystemTerminalShortcut(input)) return
    const win = findHostWindowForWebContents(wc)
    if (!win) return
    event.preventDefault()
    onToggle(win)
  })
}

/** Hook every current and future webContents. Call once at app ready. */
export function installSystemTerminalShortcut(onToggle: (win: BrowserWindow) => void): void {
  app.on('web-contents-created', (_event, wc) => hook(wc, onToggle))
  for (const wc of electronWebContents.getAllWebContents()) hook(wc, onToggle)
}
