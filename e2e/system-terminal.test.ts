/**
 * E2E: the Ctrl+Alt+T system terminal overlay.
 *
 * Drives the real chord through Electron's input pipeline (so the
 * `before-input-event` hook is what opens it), runs a command in the real
 * shell, and checks the overlay sits inside the host window rather than in a
 * window of its own — the point of the feature under a kiosk compositor.
 *
 * Tagged `@linux`: the assertions run a POSIX shell command.
 */

import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'
import { WebContentsPage, waitForWebContents } from './support/cdpPages'
import { captureHostWindow } from './support/windowCapture'

test.describe.configure({ mode: 'serial' })

let ctx: AppContext
let terminal: WebContentsPage

/** Send Ctrl+Alt+T to the first webContents whose URL contains `marker`. */
async function pressChord(app: ElectronApplication, marker: string): Promise<void> {
  await app.evaluate(({ webContents }, m) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(m))
    if (!wc) throw new Error(`no webContents for ${m}`)
    wc.focus()
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control', 'alt'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control', 'alt'] })
  }, marker)
}

/** Main-side visibility of the overlay view, plus how many windows exist. */
async function overlayState(
  app: ElectronApplication,
): Promise<{ visible: boolean; windows: number; bounds: Electron.Rectangle | null }> {
  return app.evaluate(({ BaseWindow, WebContentsView }) => {
    const windows = BaseWindow.getAllWindows().filter((w) => !w.isDestroyed())
    for (const win of windows) {
      for (const child of win.contentView.children) {
        if (!(child instanceof WebContentsView)) continue
        if (!child.webContents.getURL().includes('systemTerminal.html')) continue
        return { visible: child.getVisible(), windows: windows.length, bounds: child.getBounds() }
      }
    }
    return { visible: false, windows: windows.length, bounds: null }
  })
}

/**
 * Type a line and run it. The text goes in through `insertText` and Enter as a key event;
 * Chromium delivers those through different paths, so Enter is only sent once the shell has
 * echoed the text back — otherwise it can overtake the text and run an empty line.
 */
async function typeLine(app: ElectronApplication, text: string): Promise<void> {
  const echoesBefore = (await screenText()).split(text).length - 1
  await app.evaluate(({ webContents }, line) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('systemTerminal.html'))
    if (!wc) throw new Error('no terminal webContents')
    wc.insertText(line)
  }, text)
  await expect
    .poll(async () => (await screenText()).split(text).length - 1, { timeout: 10_000 })
    .toBeGreaterThan(echoesBefore)
  await app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('systemTerminal.html'))
    if (!wc) throw new Error('no terminal webContents')
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  })
}

/** The renderer has attached to the shell and xterm holds keyboard focus —
 *  the point from which typed keys reach the shell. */
async function waitForReady(): Promise<void> {
  await expect
    .poll(
      () =>
        terminal.evaluate<boolean>(
          `!!document.querySelector('[data-ready="true"]') && document.activeElement?.classList.contains('xterm-helper-textarea') === true`,
        ),
      { timeout: 10_000 },
    )
    .toBe(true)
}

function screenText(): Promise<string> {
  return terminal.evaluate<string>(
    `(document.querySelector('.xterm-rows')?.textContent || '').replace(/\\u00a0/g, ' ')`,
  )
}

test.beforeAll(async () => {
  ctx = await launchApp({ settings: { firstUseCompleted: true } })
  await expectChooserVisible(ctx.panel)
  terminal = new WebContentsPage(ctx.app, 'systemTerminal.html')
})

test.afterAll(async () => {
  await ctx?.cleanup()
})

test('Ctrl+Alt+T opens a terminal inside the host window @linux', async () => {
  const before = await overlayState(ctx.app)
  await pressChord(ctx.app, 'panel.html')
  await waitForWebContents(ctx.app, 'systemTerminal.html')
  await expect.poll(async () => (await overlayState(ctx.app)).visible, { timeout: 10_000 }).toBe(true)

  const state = await overlayState(ctx.app)
  // Inside the existing window, below the title bar — no new top-level window.
  expect(state.windows).toBe(before.windows)
  expect(state.bounds!.y).toBeGreaterThan(0)
  await waitForReady()
})

test('runs commands in the system shell @linux', async () => {
  await typeLine(ctx.app, 'echo "hello-$((6*7))"')
  await expect.poll(screenText, { timeout: 10_000 }).toContain('hello-42')

  const file = path.join(test.info().outputDir, 'system-terminal.png')
  await mkdir(path.dirname(file), { recursive: true })
  await captureHostWindow(ctx.app, ctx.panel, file)
  await test.info().attach('system-terminal', { path: file, contentType: 'image/png' })
})

test('Ctrl+Alt+T from inside the terminal hides it and keeps the session @linux', async () => {
  await pressChord(ctx.app, 'systemTerminal.html')
  await expect.poll(async () => (await overlayState(ctx.app)).visible, { timeout: 10_000 }).toBe(false)

  await pressChord(ctx.app, 'panel.html')
  await expect.poll(async () => (await overlayState(ctx.app)).visible, { timeout: 10_000 }).toBe(true)
  await waitForReady()
  expect(await screenText()).toContain('hello-42')
})

test('typing exit ends the shell and puts the terminal away @linux', async () => {
  await typeLine(ctx.app, 'exit')
  await expect.poll(async () => (await overlayState(ctx.app)).visible, { timeout: 10_000 }).toBe(false)

  // The next open starts a fresh shell with a clean screen.
  await pressChord(ctx.app, 'panel.html')
  await expect.poll(async () => (await overlayState(ctx.app)).visible, { timeout: 10_000 }).toBe(true)
  await waitForReady()
  expect(await screenText()).not.toContain('hello-42')
})
