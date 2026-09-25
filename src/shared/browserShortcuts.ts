// Keyboard shortcuts for the contained browser. Matched in main for page
// views (before the page sees the key) and in the apps overlay renderer for
// its own chrome, so the same keys work wherever focus is.

export type BrowserShortcut =
  | 'focus-address'
  | 'new-tab'
  | 'close-tab'
  | 'reload'
  | 'back'
  | 'forward'
  | 'next-tab'
  | 'previous-tab'

export interface BrowserKeyLike {
  type: string
  key: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

export function matchBrowserShortcut(e: BrowserKeyLike): BrowserShortcut | null {
  if (e.type !== 'keyDown' && e.type !== 'keydown') return null
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const ctrlOnly = e.control && !e.alt && !e.meta
  if (ctrlOnly && !e.shift) {
    if (key === 'l') return 'focus-address'
    if (key === 't') return 'new-tab'
    if (key === 'w') return 'close-tab'
    if (key === 'r') return 'reload'
  }
  if (ctrlOnly && key === 'Tab') return e.shift ? 'previous-tab' : 'next-tab'
  if (!e.control && !e.alt && !e.meta && !e.shift && key === 'F5') return 'reload'
  if (e.alt && !e.control && !e.meta && !e.shift) {
    if (key === 'ArrowLeft') return 'back'
    if (key === 'ArrowRight') return 'forward'
  }
  return null
}
