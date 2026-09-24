/**
 * Beta-features opt-in — title-popup Global Settings.
 *
 * The opt-in has no prerequisite: the switch is live in both directions.
 * `BooleanToggle.vue` keys a blocked state on `aria-disabled` rather than the
 * native `disabled` attribute, so these assertions read the ARIA state to
 * prove the row is never blocked.
 *
 * The opt-in is seeded pre-launch (`SeedOptions.settings`) because the
 * snapshot is built from persisted settings, so each state gets its own app
 * instance rather than in-test mutation.
 */

import { expect, test } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { openTitleMenu } from './support/chooserHelpers'
import {
  closeTitlePopupIfOpen,
  titlePopupPage,
  TITLE_REOPEN_SUPPRESSION_MS,
  type WebContentsPage,
} from './support/cdpPages'

test.describe.configure({ mode: 'serial' })

/** `settings.betaFeaturesEnabled` in locales/en.json — also the switch's
 *  `aria-label`, since `BooleanToggle` labels itself from `field.label`. */
const BETA_LABEL = 'Opt in to beta features'
const BETA_SWITCH = `.global-settings button[role="switch"][aria-label="${BETA_LABEL}"]`

interface BetaRowState {
  /** `null` when the attribute is absent; Vue renders `"false"` when enabled. */
  ariaDisabled: string | null
  ariaChecked: string | null
  /** `null` when unblocked — the tooltip binding resolves to `undefined`. */
  title: string | null
  /** Text of the element `aria-describedby` points at, if any. */
  describedText: string | null
}

/**
 * Read the beta switch's semantic state in one round trip. Attributes are read
 * with `getAttribute` (not `.disabled` / `.checked`) because the component sets
 * ARIA state on a plain `<button>`, where the DOM properties do not exist.
 */
async function readBetaRow(popup: WebContentsPage): Promise<BetaRowState | null> {
  return popup.evaluate<BetaRowState | null>(`(() => {
    const el = document.querySelector(${JSON.stringify(BETA_SWITCH)})
    if (!el) return null
    const describedBy = el.getAttribute('aria-describedby')
    const description = describedBy ? document.getElementById(describedBy) : null
    return {
      ariaDisabled: el.getAttribute('aria-disabled'),
      ariaChecked: el.getAttribute('aria-checked'),
      title: el.getAttribute('title'),
      describedText: description ? (description.textContent || '').trim() : null,
    }
  })()`)
}

/** Walk the real UI to the beta section: title menu -> Desktop Settings ->
 *  General tab (the default landing tab). Closes any open popup first so the
 *  walk is identical whichever test ran before it. */
async function openDesktopSettings(ctx: AppContext, popup: WebContentsPage): Promise<void> {
  await closeTitlePopupIfOpen(ctx.app)
  await new Promise((resolve) => setTimeout(resolve, TITLE_REOPEN_SUPPRESSION_MS))
  await openTitleMenu(ctx.titleBar)
  await popup.waitForVisible('[role="menuitem"]', { timeout: 10_000 })
  expect(await popup.clickByText('[role="menuitem"]', 'Desktop Settings')).toBe(true)
  await popup.waitForVisible('.global-settings', { timeout: 10_000 })
  await popup.waitForVisible(BETA_SWITCH, { timeout: 10_000 })
}

/** Launch an app instance seeded with a given opt-in state, bound to the
 *  enclosing describe block. */
function betaScenario(settings: Record<string, unknown>): () => WebContentsPage {
  let ctx: AppContext
  let popup: WebContentsPage

  test.beforeAll(async () => {
    ctx = await launchApp({ settings: { firstUseCompleted: true, ...settings } })
    popup = titlePopupPage(ctx.app)
  })

  test.beforeEach(async () => {
    await openDesktopSettings(ctx, popup)
  })

  test.afterAll(async () => {
    await ctx?.cleanup()
  })

  return () => popup
}

test.describe('opt-in off', () => {
  const popup = betaScenario({ betaFeaturesEnabled: false })

  test('the beta opt-in row is enabled and off @windows @macos @linux', async () => {
    const state = await readBetaRow(popup())
    expect(state, 'beta opt-in switch missing from Global Settings').not.toBeNull()
    expect(state!.ariaDisabled).toBe('false')
    expect(state!.ariaChecked).toBe('false')
    // Unblocked rows carry no explanatory tooltip at all.
    expect(state!.title).toBeNull()
    expect(state!.describedText).toBeNull()
  })

  test('clicking the beta opt-in row turns it on @windows @macos @linux', async () => {
    expect(await popup().click(BETA_SWITCH)).toBe(true)
    await expect.poll(async () => (await readBetaRow(popup()))?.ariaChecked).toBe('true')
  })
})

test.describe('opt-in on', () => {
  const popup = betaScenario({ betaFeaturesEnabled: true })

  test('the beta opt-in row is enabled and on when opted in @windows @macos @linux', async () => {
    const state = await readBetaRow(popup())
    expect(state, 'beta opt-in switch missing from Global Settings').not.toBeNull()
    expect(state!.ariaDisabled).toBe('false')
    expect(state!.ariaChecked).toBe('true')
    expect(state!.title).toBeNull()
  })
})
