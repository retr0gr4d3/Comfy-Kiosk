// URL handling for the contained browser, shared by main (navigation guard)
// and the apps overlay renderer (address bar).

/** Schemes a contained browser tab may load. Everything else (file:, data:,
 *  javascript:, custom protocols) is refused so a page can't reach the local
 *  filesystem or hand off to an external handler that would open a window
 *  over the kiosk. */
const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:'])

export function isNavigableUrl(raw: string): boolean {
  if (raw === 'about:blank') return true
  try {
    return NAVIGABLE_PROTOCOLS.has(new URL(raw).protocol)
  } catch {
    return false
  }
}

const HOST_LIKE =
  /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]|([a-z0-9-]+\.)+[a-z]{2,})(:\d{1,5})?([/?#].*)?$/i

/**
 * Turn what the user typed into the address bar into a URL to load.
 *
 * - A full http(s) URL loads as-is.
 * - Something that looks like a host (`example.com`, `localhost:8188/x`,
 *   `192.168.1.5`) gets a scheme: `http://` for local/LAN addresses (where
 *   ComfyUI and friends usually serve plain HTTP), `https://` otherwise.
 * - Anything else is a search, via `searchTemplate` (`%s` = the query).
 *
 * Returns null for empty input or a URL with a refused scheme.
 */
export function resolveAddressInput(input: string, searchTemplate: string): string | null {
  const text = input.trim()
  if (!text) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !HOST_LIKE.test(text)) {
    return isNavigableUrl(text) ? new URL(text).toString() : null
  }
  if (!/\s/.test(text) && HOST_LIKE.test(text)) {
    const host = text.split(/[/?#:]/, 1)[0]!.toLowerCase()
    const local =
      host === 'localhost' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.startsWith('[')
    return new URL(`${local ? 'http' : 'https'}://${text}`).toString()
  }
  return searchTemplate.replace('%s', encodeURIComponent(text))
}

/** What the address bar shows for a URL: the URL itself, but nothing for a
 *  blank page so the placeholder shows through. */
export function displayAddress(url: string): string {
  return url === 'about:blank' ? '' : url
}
