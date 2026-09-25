/** Contract between the apps overlay renderer, its preload and main. */

import type { BrowserShortcut } from '../shared/browserShortcuts'

export type AppKind = 'browser' | 'web' | 'terminal'

export interface AppEntry {
  id: string
  name: string
  kind: AppKind
  /** Start URL (`web` apps only). */
  url?: string
}

export interface BrowserTabState {
  id: number
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Set when the last main-frame load failed; the page view is hidden and
   *  the renderer shows an error panel instead. */
  error: string | null
}

export interface AppsOverlayState {
  apps: AppEntry[]
  tabs: BrowserTabState[]
  /** `null` shows the launcher grid. */
  activeTabId: number | null
  /** Transient one-line notice (e.g. a finished download). */
  notice: string | null
  searchTemplate: string
}

/** Localized UI copy, pushed with every show. */
export interface AppsOverlayStrings {
  title: string
  hint: string
  close: string
  newTab: string
  closeTab: string
  back: string
  forward: string
  reload: string
  stop: string
  addressPlaceholder: string
  loadFailed: string
  retry: string
  launcherHeading: string
  untitled: string
}

export interface ContentRect {
  x: number
  y: number
  width: number
  height: number
}

export interface AppsOverlayBridge {
  ready(): void
  requestClose(): void
  openApp(appId: string): void
  newTab(): void
  activateTab(tabId: number | null): void
  closeTab(tabId: number): void
  navigate(tabId: number, input: string): void
  back(tabId: number): void
  forward(tabId: number): void
  reload(tabId: number): void
  stop(tabId: number): void
  shortcut(action: BrowserShortcut): void
  /** Move keyboard focus from the chrome into the active page. */
  focusPage(): void
  /** Where the page area sits in the overlay, in CSS px. */
  setContentRect(rect: ContentRect): void
  onShow(cb: (strings: AppsOverlayStrings) => void): () => void
  onState(cb: (state: AppsOverlayState) => void): () => void
  onFocusAddress(cb: () => void): () => void
}
