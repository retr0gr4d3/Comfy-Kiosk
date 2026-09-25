import fs from 'fs'
import os from 'os'
import path from 'path'
import type { WebContents } from 'electron'
import type * as NodePty from 'node-pty'
import type { SystemTerminalRestore } from '../../types/systemTerminal'
import { loadPty } from './terminal'

/**
 * The app-wide system shell behind the Ctrl+Alt+T terminal overlay.
 *
 * Unlike the per-install consoles in `terminal.ts`, this is a plain login
 * shell in the user's home directory with no ComfyUI environment activated:
 * it is how a kiosk user (e.g. under cage, where a separate terminal window
 * can't be shown alongside the app) reaches the rest of the system.
 *
 * There is exactly one session, shared by every host window's overlay, so
 * toggling the overlay (or opening it in another window) never loses what the
 * user was doing. Typing `exit` ends the session; the next open spawns a
 * fresh shell.
 */

const MAX_BUFFER_CHUNKS = 2000
const DEFAULT_SIZE = { cols: 100, rows: 30 }

export const SYSTEM_TERMINAL_OUTPUT_CHANNEL = 'system-terminal:output'
export const SYSTEM_TERMINAL_EXITED_CHANNEL = 'system-terminal:exited'

/** Env vars the launcher sets for itself that must not leak into the user's
 *  shell: they change how child Electron/Node processes behave, or carry
 *  harness-only payloads. */
const DROPPED_ENV_PREFIXES = ['ELECTRON_', 'E2E_', 'VITE_']
const DROPPED_ENV_KEYS = ['NODE_OPTIONS', 'APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'CHROME_DESKTOP']
/** Path-list vars an AppImage runtime prepends its bundle dirs to. Entries
 *  pointing inside the bundle are stripped so system programs load system
 *  libraries, not the app's. */
const PATH_LIST_KEYS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']

/**
 * Environment for the system shell: the launcher's own environment minus
 * launcher-internal variables and AppImage bundle paths, plus the terminal
 * identification a TUI program expects.
 */
export function buildSystemShellEnv(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const appDir = source['APPDIR']
  const sep = platform === 'win32' ? ';' : ':'
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (DROPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    if (DROPPED_ENV_KEYS.includes(key)) continue
    if (appDir && PATH_LIST_KEYS.includes(key)) {
      const kept = value
        .split(sep)
        .filter((entry) => entry && entry !== appDir && !entry.startsWith(appDir + path.sep))
      if (kept.length === 0) continue
      env[key] = kept.join(sep)
      continue
    }
    env[key] = value
  }
  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'
  env['TERM_PROGRAM'] = 'ComfyDesktop'
  return env
}

export interface SystemShell {
  file: string
  args: string[]
}

/** Shells known to accept `-l` for a login shell (reads the user's profile,
 *  so PATH and prompt match what they get on a normal console). */
const LOGIN_SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'mksh'])

/**
 * Pick the user's shell: `$SHELL`, then the passwd entry, then the first of
 * bash/sh that exists. On Windows, PowerShell (or `COMSPEC`).
 */
export function resolveSystemShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = fs.existsSync,
  passwdShell: () => string | null = () => {
    try {
      return os.userInfo().shell
    } catch {
      return null
    }
  }
): SystemShell {
  if (platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'] }
  }
  const candidates = [env['SHELL'], passwdShell(), '/bin/bash', '/usr/bin/bash', '/bin/sh']
  const file = candidates.find((c): c is string => !!c && path.isAbsolute(c) && exists(c))
  if (!file) return { file: '/bin/sh', args: [] }
  return { file, args: LOGIN_SHELLS.has(path.basename(file)) ? ['-l'] : [] }
}

type ExitListener = () => void

class SystemTerminalSession {
  #pty: NodePty.IPty | undefined
  #spawnInFlight: Promise<void> | undefined
  #exited = true
  readonly buffer: string[] = []
  readonly size = { ...DEFAULT_SIZE }
  readonly subscribers = new Set<WebContents>()
  readonly exitListeners = new Set<ExitListener>()

  get exited(): boolean {
    return this.#exited || this.#pty === undefined
  }

  async ensureAlive(): Promise<void> {
    if (this.#pty && !this.#exited) return
    // Several overlays can subscribe at once; spawn one shell, not one each.
    this.#spawnInFlight ??= this.#spawn().finally(() => {
      this.#spawnInFlight = undefined
    })
    await this.#spawnInFlight
  }

  write(data: string): void {
    if (this.#exited || !this.#pty) return
    this.#pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    this.size.cols = Math.max(1, Math.floor(cols))
    this.size.rows = Math.max(1, Math.floor(rows))
    if (this.#exited || !this.#pty) return
    try {
      this.#pty.resize(this.size.cols, this.size.rows)
    } catch {
      // The shell may have died between the check and the resize.
    }
  }

  restore(): SystemTerminalRestore {
    return { buffer: [...this.buffer], size: { ...this.size }, exited: this.exited }
  }

  subscribe(wc: WebContents): void {
    if (this.subscribers.has(wc)) return
    this.subscribers.add(wc)
    wc.once('destroyed', () => this.subscribers.delete(wc))
  }

  dispose(): void {
    const instance = this.#pty
    this.#pty = undefined
    this.#exited = true
    this.buffer.length = 0
    this.subscribers.clear()
    if (!instance) return
    try {
      instance.kill()
    } catch {
      // Already gone.
    }
  }

  async #spawn(): Promise<void> {
    this.buffer.length = 0
    const shell = resolveSystemShell()
    const home = os.homedir()
    const pty = await loadPty()
    const instance = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: this.size.cols,
      rows: this.size.rows,
      cwd: home && fs.existsSync(home) ? home : process.cwd(),
      env: buildSystemShellEnv(process.env)
    })
    this.#pty = instance
    this.#exited = false

    instance.onData((data) => {
      if (this.#pty !== instance) return
      this.buffer.push(data)
      if (this.buffer.length > MAX_BUFFER_CHUNKS) this.buffer.shift()
      this.#broadcast(SYSTEM_TERMINAL_OUTPUT_CHANNEL, data)
    })

    instance.onExit(() => {
      if (this.#pty !== instance) return
      this.#exited = true
      this.#pty = undefined
      this.buffer.length = 0
      this.#broadcast(SYSTEM_TERMINAL_EXITED_CHANNEL, null)
      for (const listener of [...this.exitListeners]) {
        try {
          listener()
        } catch {
          // A failing listener must not stop the others.
        }
      }
    })
  }

  #broadcast(channel: string, payload: unknown): void {
    for (const wc of this.subscribers) {
      if (wc.isDestroyed()) {
        this.subscribers.delete(wc)
        continue
      }
      wc.send(channel, payload)
    }
  }
}

let session = new SystemTerminalSession()

/** Subscribe an overlay renderer, spawning the shell if needed, and return
 *  the scrollback so it can repaint. */
export async function subscribeSystemTerminal(wc: WebContents): Promise<SystemTerminalRestore> {
  await session.ensureAlive()
  session.subscribe(wc)
  return session.restore()
}

export function writeSystemTerminal(data: string): void {
  session.write(data)
}

export function resizeSystemTerminal(cols: number, rows: number): void {
  session.resize(cols, rows)
}

/** Register a callback for the shell exiting on its own (e.g. `exit`).
 *  Returns an unsubscribe function. */
export function onSystemTerminalExit(listener: ExitListener): () => void {
  session.exitListeners.add(listener)
  return () => session.exitListeners.delete(listener)
}

/** Kill the shell (app quit). Exit listeners are not called. */
export function disposeSystemTerminal(): void {
  const listeners = session.exitListeners
  session.dispose()
  session = new SystemTerminalSession()
  for (const listener of listeners) session.exitListeners.add(listener)
}
