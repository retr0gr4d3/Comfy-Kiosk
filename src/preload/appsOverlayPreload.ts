import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { AppsOverlayBridge, AppsOverlayState, AppsOverlayStrings } from '../types/appsOverlay'

/**
 * Bridge for the apps overlay renderer (`appsOverlay.html`): the launcher
 * grid and the contained browser's chrome. Main only honours these channels
 * from overlay renderers. The browsed pages themselves get no preload at all.
 */

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const send =
  (channel: string) =>
  (...args: unknown[]): void =>
    ipcRenderer.send(channel, ...args)

const bridge: AppsOverlayBridge = {
  ready: send('apps-overlay:ready'),
  requestClose: send('apps-overlay:request-close'),
  openApp: send('apps-overlay:open-app'),
  newTab: send('apps-overlay:new-tab'),
  activateTab: send('apps-overlay:activate-tab'),
  closeTab: send('apps-overlay:close-tab'),
  navigate: send('apps-overlay:navigate'),
  back: send('apps-overlay:back'),
  forward: send('apps-overlay:forward'),
  reload: send('apps-overlay:reload'),
  stop: send('apps-overlay:stop'),
  shortcut: send('apps-overlay:shortcut'),
  focusPage: send('apps-overlay:focus-page'),
  setContentRect: send('apps-overlay:content-rect'),
  onShow: (cb) => subscribe<AppsOverlayStrings>('apps-overlay:show', cb),
  onState: (cb) => subscribe<AppsOverlayState>('apps-overlay:state', cb),
  onFocusAddress: (cb) => subscribe<void>('apps-overlay:focus-address', () => cb())
}

contextBridge.exposeInMainWorld('appsOverlay', bridge)
