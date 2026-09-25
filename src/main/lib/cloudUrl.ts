/** Human-readable form of a launch URL: just the host (e.g. "cloud.comfy.org").
 *  Used for "Connecting to …" status text so the path/query don't leak into the UI. Host is parsed from the URL, never hardcoded, so it works for
 *  any remote/cloud target. `url.host` keeps a non-default port if present. */
export function displayLaunchUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).host
  } catch {
    return rawUrl
  }
}
