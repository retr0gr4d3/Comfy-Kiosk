import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { SystemTerminalBridge, SystemTerminalShowPayload } from '../types/systemTerminal'

/**
 * Bridge for the in-window system terminal overlay (`systemTerminal.html`).
 * Main only honours these channels from overlay renderers, so this preload is
 * the one route to the system shell.
 */

function listen(channel: string, cb: () => void): () => void {
  const handler = (): void => cb()
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const bridge: SystemTerminalBridge = {
  platform: process.platform,
  ready: () => ipcRenderer.send('system-terminal:ready'),
  subscribe: () => ipcRenderer.invoke('system-terminal:subscribe'),
  write: (data) => ipcRenderer.send('system-terminal:write', data),
  resize: (cols, rows) => ipcRenderer.send('system-terminal:resize', cols, rows),
  requestClose: () => ipcRenderer.send('system-terminal:request-close'),
  notifyHidden: () => ipcRenderer.send('system-terminal:hidden'),
  onShow: (cb) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const p = (payload ?? {}) as Partial<SystemTerminalShowPayload>
      cb({
        title: typeof p.title === 'string' ? p.title : 'Terminal',
        hint: typeof p.hint === 'string' ? p.hint : 'Ctrl+Alt+T',
        close: typeof p.close === 'string' ? p.close : 'Close'
      })
    }
    ipcRenderer.on('system-terminal:show', handler)
    return () => ipcRenderer.removeListener('system-terminal:show', handler)
  },
  onHide: (cb) => listen('system-terminal:hide', cb),
  onOutput: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      if (typeof data === 'string') cb(data)
    }
    ipcRenderer.on('system-terminal:output', handler)
    return () => ipcRenderer.removeListener('system-terminal:output', handler)
  },
  onExited: (cb) => listen('system-terminal:exited', cb)
}

contextBridge.exposeInMainWorld('systemTerminal', bridge)
