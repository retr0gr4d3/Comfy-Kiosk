import type { BrowserWindow } from 'electron'
import {
  closeAppsOverlay,
  isAppsOverlayOpen,
  raiseAppsOverlayIfOpen,
  toggleAppsOverlay
} from './appsOverlay'
import {
  closeSystemTerminal,
  isSystemTerminalOpen,
  raiseSystemTerminalIfOpen,
  toggleSystemTerminal
} from './systemTerminalView'

/**
 * The overlays that cover a host window's body (system terminal, apps
 * launcher). At most one is up at a time: opening one puts the other away,
 * so a hidden overlay never lingers underneath and swallows the next toggle.
 */

export function toggleTerminalOverlay(win: BrowserWindow): void {
  if (!isSystemTerminalOpen(win)) closeAppsOverlay(win)
  toggleSystemTerminal(win)
}

export function toggleAppsLauncher(win: BrowserWindow): void {
  if (!isAppsOverlayOpen(win)) closeSystemTerminal(win)
  toggleAppsOverlay(win)
}

/** Keep open overlays above views added to `win` after they opened (a lazily
 *  built panel, a rebuilt ComfyUI view). */
export function raiseBodyOverlays(win: BrowserWindow): void {
  raiseAppsOverlayIfOpen(win)
  raiseSystemTerminalIfOpen(win)
}
