import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null },
  webContents: { getAllWebContents: () => [] }
}))
vi.mock('../host/registry', () => ({ comfyWindows: new Map() }))

import { isSystemTerminalShortcut } from './systemTerminalShortcut'

const base = {
  type: 'keyDown' as const,
  key: 't',
  code: 'KeyT',
  control: true,
  alt: true,
  shift: false,
  meta: false
}

describe('isSystemTerminalShortcut', () => {
  it('matches Ctrl+Alt+T', () => {
    expect(isSystemTerminalShortcut(base)).toBe(true)
  })

  it('matches by physical key on layouts where T is elsewhere', () => {
    expect(isSystemTerminalShortcut({ ...base, key: 'ţ' })).toBe(true)
  })

  it('matches by letter when the layout moves it off the T key', () => {
    expect(isSystemTerminalShortcut({ ...base, code: 'KeyK', key: 'T' })).toBe(true)
  })

  it.each([
    ['without Ctrl', { control: false }],
    ['without Alt', { alt: false }],
    ['with Shift', { shift: true }],
    ['with Meta', { meta: true }],
    ['on key-up', { type: 'keyUp' as const }],
    ['on auto-repeat', { isAutoRepeat: true }],
    ['for another key', { key: 'y', code: 'KeyY' }]
  ])('ignores the chord %s', (_label, over) => {
    expect(isSystemTerminalShortcut({ ...base, ...over })).toBe(false)
  })
})
