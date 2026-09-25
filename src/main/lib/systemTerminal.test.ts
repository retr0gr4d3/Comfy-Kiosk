import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Fake node-pty: lets a test drive output/exit and inspect writes. */
const { spawned, spawn } = vi.hoisted(() => {
  class FakePty {
    dataCb: ((d: string) => void) | undefined
    exitCb: (() => void) | undefined
    written: string[] = []
    killed = false
    constructor(
      public file: string,
      public args: string[],
      public opts: { cols: number; rows: number; cwd: string; env: Record<string, string> }
    ) {}
    onData(cb: (d: string) => void) {
      this.dataCb = cb
      return { dispose() {} }
    }
    onExit(cb: () => void) {
      this.exitCb = cb
      return { dispose() {} }
    }
    write(d: string) {
      this.written.push(d)
    }
    resize(cols: number, rows: number) {
      this.opts.cols = cols
      this.opts.rows = rows
    }
    kill() {
      this.killed = true
    }
  }
  const spawned: FakePty[] = []
  const spawn = (
    file: string,
    args: string[],
    opts: { cols: number; rows: number; cwd: string; env: Record<string, string> }
  ) => {
    const p = new FakePty(file, args, opts)
    spawned.push(p)
    return p
  }
  return { spawned, spawn }
})

vi.mock('./terminal', () => ({ loadPty: async () => ({ spawn }) }))

import {
  buildSystemShellEnv,
  disposeSystemTerminal,
  onSystemTerminalExit,
  resizeSystemTerminal,
  resolveSystemShell,
  subscribeSystemTerminal,
  SYSTEM_TERMINAL_EXITED_CHANNEL,
  SYSTEM_TERMINAL_OUTPUT_CHANNEL,
  writeSystemTerminal
} from './systemTerminal'

function fakeWebContents() {
  return {
    id: Math.random(),
    send: vi.fn(),
    isDestroyed: () => false,
    once: vi.fn()
  } as unknown as Electron.WebContents & { send: ReturnType<typeof vi.fn> }
}

describe('buildSystemShellEnv', () => {
  it('drops launcher-internal variables and identifies the terminal', () => {
    const env = buildSystemShellEnv(
      {
        HOME: '/home/kiosk',
        LANG: 'en_US.UTF-8',
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_RENDERER_URL: 'http://localhost:5173',
        E2E_SETTINGS_SEED: '{}',
        NODE_OPTIONS: '--inspect',
        TERM: 'dumb'
      },
      'linux'
    )
    expect(env).toEqual({
      HOME: '/home/kiosk',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'ComfyDesktop'
    })
  })

  it('strips AppImage bundle paths so system programs load system libraries', () => {
    const env = buildSystemShellEnv(
      {
        APPDIR: '/tmp/.mount_Comfy',
        APPIMAGE: '/opt/Comfy.AppImage',
        PATH: '/tmp/.mount_Comfy/usr/bin:/usr/local/bin:/usr/bin',
        LD_LIBRARY_PATH: '/tmp/.mount_Comfy/usr/lib:/tmp/.mount_Comfy',
        XDG_DATA_DIRS: '/tmp/.mount_Comfy/usr/share:/usr/share'
      },
      'linux'
    )
    expect(env['PATH']).toBe('/usr/local/bin:/usr/bin')
    expect(env['XDG_DATA_DIRS']).toBe('/usr/share')
    // Nothing left: the variable is dropped rather than set empty.
    expect(env).not.toHaveProperty('LD_LIBRARY_PATH')
    expect(env).not.toHaveProperty('APPDIR')
    expect(env).not.toHaveProperty('APPIMAGE')
  })

  it('leaves path lists alone outside an AppImage', () => {
    const env = buildSystemShellEnv({ LD_LIBRARY_PATH: '/opt/lib:/usr/lib' }, 'linux')
    expect(env['LD_LIBRARY_PATH']).toBe('/opt/lib:/usr/lib')
  })
})

describe('resolveSystemShell', () => {
  const exists = (known: string[]) => (p: string) => known.includes(p)

  it('runs $SHELL as a login shell', () => {
    expect(
      resolveSystemShell({ SHELL: '/usr/bin/zsh' }, 'linux', exists(['/usr/bin/zsh']), () => null)
    ).toEqual({ file: '/usr/bin/zsh', args: ['-l'] })
  })

  it('falls back to the passwd shell when $SHELL is unset or missing', () => {
    expect(
      resolveSystemShell(
        { SHELL: '/missing/shell' },
        'linux',
        exists(['/usr/bin/fish']),
        () => '/usr/bin/fish'
      )
    ).toEqual({ file: '/usr/bin/fish', args: ['-l'] })
  })

  it('falls back to bash, then sh', () => {
    expect(resolveSystemShell({}, 'linux', exists(['/bin/bash']), () => null)).toEqual({
      file: '/bin/bash',
      args: ['-l']
    })
    expect(resolveSystemShell({}, 'linux', exists([]), () => null)).toEqual({
      file: '/bin/sh',
      args: []
    })
  })

  it('passes no login flag to shells it does not know', () => {
    expect(
      resolveSystemShell({ SHELL: '/usr/bin/nu' }, 'linux', exists(['/usr/bin/nu']), () => null)
    ).toEqual({ file: '/usr/bin/nu', args: [] })
  })

  it('ignores a relative $SHELL', () => {
    expect(
      resolveSystemShell({ SHELL: 'bash' }, 'linux', exists(['bash', '/bin/sh']), () => null)
    ).toEqual({ file: '/bin/sh', args: ['-l'] })
  })

  it('uses PowerShell on Windows', () => {
    expect(resolveSystemShell({}, 'win32')).toEqual({ file: 'powershell.exe', args: ['-NoLogo'] })
  })
})

describe('system terminal session', () => {
  beforeEach(() => {
    spawned.length = 0
    disposeSystemTerminal()
  })

  afterEach(() => {
    disposeSystemTerminal()
  })

  it('spawns one shell for concurrent subscribers, in the home directory', async () => {
    const [a, b] = await Promise.all([
      subscribeSystemTerminal(fakeWebContents()),
      subscribeSystemTerminal(fakeWebContents())
    ])
    expect(spawned).toHaveLength(1)
    const home = os.homedir()
    expect(spawned[0]!.opts.cwd).toBe(home || process.cwd())
    expect(path.isAbsolute(spawned[0]!.file)).toBe(true)
    expect(spawned[0]!.opts.env['TERM']).toBe('xterm-256color')
    expect(a.exited).toBe(false)
    expect(b.exited).toBe(false)
  })

  it('broadcasts output to subscribers and replays it to late subscribers', async () => {
    const early = fakeWebContents()
    await subscribeSystemTerminal(early)
    spawned[0]!.dataCb?.('$ ')
    expect(early.send).toHaveBeenCalledWith(SYSTEM_TERMINAL_OUTPUT_CHANNEL, '$ ')

    const late = await subscribeSystemTerminal(fakeWebContents())
    expect(late.buffer).toEqual(['$ '])
  })

  it('forwards input and size to the shell', async () => {
    await subscribeSystemTerminal(fakeWebContents())
    writeSystemTerminal('ls\r')
    resizeSystemTerminal(120.7, 40)
    expect(spawned[0]!.written).toEqual(['ls\r'])
    expect(spawned[0]!.opts).toMatchObject({ cols: 120, rows: 40 })
  })

  it('reports an exit and starts a fresh shell on the next subscribe', async () => {
    const wc = fakeWebContents()
    const onExit = vi.fn()
    const off = onSystemTerminalExit(onExit)
    await subscribeSystemTerminal(wc)
    spawned[0]!.dataCb?.('old output')
    spawned[0]!.exitCb?.()

    expect(onExit).toHaveBeenCalledTimes(1)
    expect(wc.send).toHaveBeenCalledWith(SYSTEM_TERMINAL_EXITED_CHANNEL, null)
    // Input after exit goes nowhere.
    writeSystemTerminal('ignored')
    expect(spawned[0]!.written).toEqual([])

    const restore = await subscribeSystemTerminal(wc)
    expect(spawned).toHaveLength(2)
    expect(restore.buffer).toEqual([])
    expect(restore.exited).toBe(false)
    off()
  })

  it('kills the shell on dispose without reporting an exit', async () => {
    const onExit = vi.fn()
    const off = onSystemTerminalExit(onExit)
    await subscribeSystemTerminal(fakeWebContents())
    disposeSystemTerminal()
    expect(spawned[0]!.killed).toBe(true)
    // A late onExit from the killed pty belongs to a replaced session.
    spawned[0]!.exitCb?.()
    expect(onExit).not.toHaveBeenCalled()
    off()
  })
})
