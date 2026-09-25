/**
 * E2E: the Ctrl+Alt+A apps launcher and its contained browser.
 *
 * A local HTTP server stands in for the web, and `apps.json` is seeded with an
 * app pointing at it. The tests drive the real chord and the real chrome, and
 * check from main's side that pages stay inside the host window: no new
 * top-level window, page views positioned below the title bar, popups turned
 * into tabs, refused schemes refused, downloads written to ~/Downloads.
 *
 * Tagged `@linux`: the apps.json seed relies on the harness's XDG isolation.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'
import { WebContentsPage, waitForWebContents } from './support/cdpPages'
import { captureHostWindow } from './support/windowCapture'

test.describe.configure({ mode: 'serial' })

let ctx: AppContext
let overlay: WebContentsPage
let server: http.Server
let origin = ''
let closedPortOrigin = ''

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body style="margin:0;background:#fafafa"><h1>${title}</h1>${body}</body></html>`
}

async function startServer(): Promise<void> {
  server = http.createServer((req, res) => {
    if (req.url === '/one') {
      res.setHeader('content-type', 'text/html')
      res.end(page('Page One', `<a id="popup" href="/two" target="_blank">two</a>`))
    } else if (req.url === '/two') {
      res.setHeader('content-type', 'text/html')
      res.end(page('Page Two', ''))
    } else if (req.url === '/file') {
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-disposition', 'attachment; filename="report.txt"')
      res.end('contained download\n')
    } else {
      res.statusCode = 404
      res.end('not found')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // A port that was open and is now closed: connection refused.
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  closedPortOrigin = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`
  await new Promise<void>((resolve) => probe.close(() => resolve()))
}

async function pressChord(app: ElectronApplication, marker: string, key: string): Promise<void> {
  await app.evaluate(
    ({ webContents }, p) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(p.marker))
      if (!wc) throw new Error(`no webContents for ${p.marker}`)
      wc.focus()
      wc.sendInputEvent({ type: 'keyDown', keyCode: p.key, modifiers: ['control', 'alt'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: p.key, modifiers: ['control', 'alt'] })
    },
    { marker, key },
  )
}

interface ViewInfo {
  url: string
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

/** Main-side picture of the host windows: every view, in paint order. */
async function snapshot(
  app: ElectronApplication,
): Promise<{ windows: number; content: { width: number; height: number }; views: ViewInfo[] }> {
  return app.evaluate(({ BaseWindow, WebContentsView }) => {
    const windows = BaseWindow.getAllWindows().filter((w) => !w.isDestroyed())
    const host = windows.find((w) => w.isVisible()) ?? windows[0]!
    const b = host.getContentBounds()
    const views = host.contentView.children
      .filter((c): c is InstanceType<typeof WebContentsView> => c instanceof WebContentsView)
      .map((v) => ({ url: v.webContents.getURL(), visible: v.getVisible(), bounds: v.getBounds() }))
    return { windows: windows.length, content: { width: b.width, height: b.height }, views }
  })
}

async function overlayVisible(): Promise<boolean> {
  const snap = await snapshot(ctx.app)
  return snap.views.some((v) => v.url.includes('appsOverlay.html') && v.visible)
}

async function visiblePages(): Promise<ViewInfo[]> {
  const snap = await snapshot(ctx.app)
  return snap.views.filter((v) => v.url.startsWith(origin) && v.visible)
}

function tabLabels(): Promise<string[]> {
  return overlay.allText('[data-testid="apps-tab"] .ao-tab-title')
}

async function submitAddress(text: string): Promise<void> {
  await overlay.evaluate(`(() => {
    const input = document.querySelector('[data-testid="apps-address"]')
    input.focus()
    input.value = ${JSON.stringify(text)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.form.requestSubmit()
  })()`)
}

async function runInPage(urlPrefix: string, script: string): Promise<void> {
  await ctx.app.evaluate(
    async ({ webContents }, p) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(p.urlPrefix))
      if (!wc) throw new Error(`no page ${p.urlPrefix}`)
      await wc.executeJavaScript(p.script)
    },
    { urlPrefix, script },
  )
}

test.beforeAll(async () => {
  await startServer()
  ctx = await launchApp({
    settings: { firstUseCompleted: true },
    onSetup: async ({ homeDir }) => {
      const dir = path.join(homeDir, '.config', 'comfyui-desktop-2')
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, 'apps.json'),
        JSON.stringify({
          browser: { homeUrl: `${origin}/one`, searchUrl: `${origin}/search?q=%s` },
          apps: [{ id: 'local', name: 'Local Test', url: `${origin}/one` }],
        }),
      )
    },
  })
  await expectChooserVisible(ctx.panel)
  overlay = new WebContentsPage(ctx.app, 'appsOverlay.html')
})

test.afterAll(async () => {
  await ctx?.cleanup()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})

test('Ctrl+Alt+A opens the launcher inside the host window @linux', async () => {
  const before = await snapshot(ctx.app)
  await pressChord(ctx.app, 'panel.html', 'A')
  await waitForWebContents(ctx.app, 'appsOverlay.html')
  await expect.poll(overlayVisible, { timeout: 10_000 }).toBe(true)
  await expect
    .poll(() => overlay.allText('.ao-tile .ao-tile-name'), { timeout: 10_000 })
    .toEqual(['Browser', 'Terminal', 'Local Test'])
  expect((await snapshot(ctx.app)).windows).toBe(before.windows)

  const file = path.join(test.info().outputDir, 'apps-overlay-launcher.png')
  await mkdir(path.dirname(file), { recursive: true })
  await captureHostWindow(ctx.app, ctx.panel, file)
  await test.info().attach('apps-overlay-launcher', { path: file, contentType: 'image/png' })
})

test('a web app opens as a tab positioned inside the overlay @linux', async () => {
  expect(await overlay.click('.ao-tile[data-app-id="web:local"]')).toBe(true)
  await expect.poll(tabLabels, { timeout: 10_000 }).toEqual(['Page One'])
  await expect.poll(async () => (await visiblePages()).length, { timeout: 10_000 }).toBe(1)

  const snap = await snapshot(ctx.app)
  const [pageView] = await visiblePages()
  const overlayView = snap.views.find((v) => v.url.includes('appsOverlay.html'))!
  // Below the title bar and the overlay's own chrome, inside the window.
  expect(pageView!.bounds.y).toBeGreaterThan(overlayView.bounds.y + 40)
  expect(pageView!.bounds.x).toBeGreaterThan(0)
  expect(pageView!.bounds.x + pageView!.bounds.width).toBeLessThan(snap.content.width)
  expect(pageView!.bounds.y + pageView!.bounds.height).toBeLessThan(snap.content.height)
  // Painted above the overlay.
  expect(snap.views.indexOf(snap.views.find((v) => v.url.startsWith(origin))!)).toBeGreaterThan(
    snap.views.indexOf(overlayView),
  )

  const file = path.join(test.info().outputDir, 'apps-overlay-browser.png')
  await mkdir(path.dirname(file), { recursive: true })
  await captureHostWindow(ctx.app, ctx.panel, file)
  await test.info().attach('apps-overlay-browser', { path: file, contentType: 'image/png' })
})

test('links that open a new window become tabs, not windows @linux', async () => {
  const windowsBefore = (await snapshot(ctx.app)).windows
  await runInPage(`${origin}/one`, `document.getElementById('popup').click()`)
  await expect.poll(tabLabels, { timeout: 10_000 }).toEqual(['Page One', 'Page Two'])
  expect((await snapshot(ctx.app)).windows).toBe(windowsBefore)
  // Only the active (new) tab's page is shown.
  await expect
    .poll(async () => (await visiblePages()).map((v) => v.url), { timeout: 10_000 })
    .toEqual([`${origin}/two`])
})

test('the address bar navigates and infers http for local hosts @linux', async () => {
  const hostPort = origin.replace('http://', '')
  await submitAddress(`${hostPort}/one`)
  await expect
    .poll(async () => (await visiblePages()).map((v) => v.url), { timeout: 10_000 })
    .toEqual([`${origin}/one`])
})

test('pages cannot navigate to refused schemes @linux', async () => {
  await runInPage(`${origin}/one`, `location.href = 'file:///etc/hostname'`)
  // Give a refused navigation time to (not) happen.
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect((await visiblePages()).map((v) => v.url)).toEqual([`${origin}/one`])
})

test('a failed load shows the error panel instead of the page @linux', async () => {
  await submitAddress(`${closedPortOrigin}/`)
  await expect.poll(() => overlay.exists('[data-testid="apps-error"]'), { timeout: 10_000 }).toBe(true)
  const snap = await snapshot(ctx.app)
  expect(snap.views.filter((v) => v.url.startsWith(closedPortOrigin) && v.visible)).toEqual([])

  await submitAddress(`${origin}/one`)
  await expect.poll(() => overlay.exists('[data-testid="apps-error"]'), { timeout: 10_000 }).toBe(false)
  await expect.poll(async () => (await visiblePages()).length, { timeout: 10_000 }).toBe(1)
})

test('downloads go straight to ~/Downloads @linux', async () => {
  await runInPage(`${origin}/one`, `location.href = '/file'`)
  const target = path.join(ctx.homeDir, 'Downloads', 'report.txt')
  await expect.poll(() => existsSync(target), { timeout: 10_000 }).toBe(true)
  await expect
    .poll(() => overlay.textOf('[data-testid="apps-notice"]'), { timeout: 10_000 })
    .toContain('report.txt')
})

test('Ctrl+Alt+A from a page hides everything and keeps the tabs @linux', async () => {
  await pressChord(ctx.app, `${origin}/one`, 'A')
  await expect.poll(overlayVisible, { timeout: 10_000 }).toBe(false)
  expect(await visiblePages()).toEqual([])

  await pressChord(ctx.app, 'panel.html', 'A')
  await expect.poll(overlayVisible, { timeout: 10_000 }).toBe(true)
  // The address-bar test navigated the second tab to /one.
  expect(await tabLabels()).toEqual(['Page One', 'Page One'])
  await expect.poll(async () => (await visiblePages()).length, { timeout: 10_000 }).toBe(1)
})

test('closing tabs returns to the launcher @linux', async () => {
  await overlay.evaluate(
    `document.querySelectorAll('[data-testid="apps-tab"] .ao-tab-close').forEach((b) => b.click())`,
  )
  await expect.poll(tabLabels, { timeout: 10_000 }).toEqual([])
  await expect.poll(() => overlay.exists('[data-testid="apps-launcher"]'), { timeout: 10_000 }).toBe(true)
  expect(await visiblePages()).toEqual([])
})

test('the Terminal tile swaps the launcher for the terminal @linux', async () => {
  expect(await overlay.click('.ao-tile[data-app-id="terminal"]')).toBe(true)
  await waitForWebContents(ctx.app, 'systemTerminal.html')
  await expect
    .poll(
      async () => {
        const snap = await snapshot(ctx.app)
        return snap.views
          .filter((v) => v.visible && /systemTerminal|appsOverlay/.test(v.url))
          .map((v) => (v.url.includes('systemTerminal') ? 'terminal' : 'apps'))
      },
      { timeout: 10_000 },
    )
    .toEqual(['terminal'])
})

test('the title-bar Apps button toggles the launcher @linux', async () => {
  // Opening the launcher puts the terminal away.
  expect(await ctx.titleBar.click('[data-testid="title-apps-button"]')).toBe(true)
  await expect.poll(overlayVisible, { timeout: 10_000 }).toBe(true)
  // The terminal hides once its exit animation finishes.
  await expect
    .poll(
      async () =>
        (await snapshot(ctx.app)).views.some((v) => v.url.includes('systemTerminal') && v.visible),
      { timeout: 10_000 },
    )
    .toBe(false)
  // The launcher paints above the terminal even while it animates out.
  const snap = await snapshot(ctx.app)
  const order = snap.views.map((v) => v.url)
  expect(order.findIndex((u) => u.includes('appsOverlay'))).toBeGreaterThan(
    order.findIndex((u) => u.includes('systemTerminal')),
  )

  expect(await ctx.titleBar.click('[data-testid="title-apps-button"]')).toBe(true)
  await expect.poll(overlayVisible, { timeout: 10_000 }).toBe(false)
})
