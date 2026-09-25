import { describe, expect, it } from 'vitest'
import { displayAddress, isNavigableUrl, resolveAddressInput } from './browserUrl'

const SEARCH = 'https://search.example/?q=%s'

describe('isNavigableUrl', () => {
  it.each(['https://comfy.org/', 'http://127.0.0.1:8188/', 'about:blank'])('allows %s', (url) => {
    expect(isNavigableUrl(url)).toBe(true)
  })

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'comfy://open',
    'ftp://host/',
    'not a url'
  ])('refuses %s', (url) => {
    expect(isNavigableUrl(url)).toBe(false)
  })
})

describe('resolveAddressInput', () => {
  it('keeps full http(s) URLs', () => {
    expect(resolveAddressInput('https://docs.comfy.org/x?y=1', SEARCH)).toBe(
      'https://docs.comfy.org/x?y=1'
    )
  })

  it('adds https to public hosts', () => {
    expect(resolveAddressInput('huggingface.co/models', SEARCH)).toBe(
      'https://huggingface.co/models'
    )
  })

  it.each([
    ['localhost:8188', 'http://localhost:8188/'],
    ['127.0.0.1:8188/api', 'http://127.0.0.1:8188/api'],
    ['192.168.1.20', 'http://192.168.1.20/'],
    ['10.0.0.5:3000', 'http://10.0.0.5:3000/'],
    ['172.20.1.1', 'http://172.20.1.1/']
  ])('uses http for local address %s', (input, expected) => {
    expect(resolveAddressInput(input, SEARCH)).toBe(expected)
  })

  it('searches for anything else', () => {
    expect(resolveAddressInput('  flux dev lora  ', SEARCH)).toBe(
      'https://search.example/?q=flux%20dev%20lora'
    )
    expect(resolveAddressInput('comfyui', SEARCH)).toBe('https://search.example/?q=comfyui')
  })

  it('refuses unsafe schemes and empty input', () => {
    expect(resolveAddressInput('file:///etc/passwd', SEARCH)).toBeNull()
    expect(resolveAddressInput('javascript:alert(1)', SEARCH)).toBeNull()
    expect(resolveAddressInput('   ', SEARCH)).toBeNull()
  })
})

describe('displayAddress', () => {
  it('hides about:blank so the placeholder shows', () => {
    expect(displayAddress('about:blank')).toBe('')
    expect(displayAddress('https://a.b/')).toBe('https://a.b/')
  })
})
