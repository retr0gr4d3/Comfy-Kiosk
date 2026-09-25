import { describe, expect, it } from 'vitest'
import { displayLaunchUrl } from './cloudUrl'

describe('displayLaunchUrl', () => {
  it('strips query params and the path down to the host', () => {
    expect(
      displayLaunchUrl(
        'https://cloud.comfy.org/workflows/123?utm_source=comfy.desktop&desktop_device_id=abc'
      )
    ).toBe('cloud.comfy.org')
  })

  it('keeps a non-default port', () => {
    expect(displayLaunchUrl('http://127.0.0.1:8188/?foo=bar')).toBe('127.0.0.1:8188')
  })

  it('returns the input unchanged when it is not a URL', () => {
    expect(displayLaunchUrl('not a url')).toBe('not a url')
  })
})
