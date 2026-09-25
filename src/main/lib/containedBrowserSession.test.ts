import path from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }))

import {
  chromeLikeUserAgent,
  isAllowedBrowserPermission,
  uniqueDownloadPath
} from './containedBrowserSession'

describe('chromeLikeUserAgent', () => {
  it('drops the Electron and app tokens', () => {
    const ua =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) comfyui-desktop-2/1.1.2 Chrome/142.0.0.0 Electron/40.4.1 Safari/537.36'
    expect(chromeLikeUserAgent(ua)).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
    )
  })
})

describe('isAllowedBrowserPermission', () => {
  it('allows only fullscreen and clipboard writes', () => {
    expect(isAllowedBrowserPermission('fullscreen')).toBe(true)
    expect(isAllowedBrowserPermission('clipboard-sanitized-write')).toBe(true)
    for (const p of ['media', 'geolocation', 'notifications', 'midi', 'openExternal', 'usb']) {
      expect(isAllowedBrowserPermission(p)).toBe(false)
    }
  })
})

describe('uniqueDownloadPath', () => {
  const dir = '/home/u/Downloads'

  it('uses the file name when free', () => {
    expect(uniqueDownloadPath(dir, 'model.safetensors', () => false)).toBe(
      path.join(dir, 'model.safetensors')
    )
  })

  it('numbers collisions before the extension', () => {
    const taken = new Set([path.join(dir, 'a.txt'), path.join(dir, 'a (1).txt')])
    expect(uniqueDownloadPath(dir, 'a.txt', (p) => taken.has(p))).toBe(path.join(dir, 'a (2).txt'))
  })

  it('never escapes the downloads dir', () => {
    expect(uniqueDownloadPath(dir, '../../etc/passwd', () => false)).toBe(path.join(dir, 'passwd'))
    expect(uniqueDownloadPath(dir, '', () => false)).toBe(path.join(dir, 'download'))
  })
})
