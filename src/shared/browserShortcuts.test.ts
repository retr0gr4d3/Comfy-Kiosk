import { describe, expect, it } from 'vitest'
import { matchBrowserShortcut, type BrowserKeyLike } from './browserShortcuts'

const key = (k: string, mods: Partial<BrowserKeyLike> = {}): BrowserKeyLike => ({
  type: 'keyDown',
  key: k,
  control: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods
})

describe('matchBrowserShortcut', () => {
  it.each([
    [key('l', { control: true }), 'focus-address'],
    [key('L', { control: true }), 'focus-address'],
    [key('t', { control: true }), 'new-tab'],
    [key('w', { control: true }), 'close-tab'],
    [key('r', { control: true }), 'reload'],
    [key('F5'), 'reload'],
    [key('ArrowLeft', { alt: true }), 'back'],
    [key('ArrowRight', { alt: true }), 'forward'],
    [key('Tab', { control: true }), 'next-tab'],
    [key('Tab', { control: true, shift: true }), 'previous-tab']
  ] as const)('maps %o to %s', (input, action) => {
    expect(matchBrowserShortcut(input)).toBe(action)
  })

  it('accepts DOM-style keydown events', () => {
    expect(matchBrowserShortcut({ ...key('t', { control: true }), type: 'keydown' })).toBe(
      'new-tab'
    )
  })

  it.each([
    ['plain letters', key('t')],
    ['Ctrl+Alt chords (app-wide overlays)', key('t', { control: true, alt: true })],
    ['Ctrl+Shift+T', key('t', { control: true, shift: true })],
    ['key-up', { ...key('t', { control: true }), type: 'keyUp' }],
    ['Alt+Left with Ctrl', key('ArrowLeft', { alt: true, control: true })]
  ])('ignores %s', (_label, input) => {
    expect(matchBrowserShortcut(input)).toBeNull()
  })
})
