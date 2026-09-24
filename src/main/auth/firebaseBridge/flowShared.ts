import type { BrowserWindow, WebContents } from 'electron'

export type FirebaseAuthFlow = 'desktop_login_code' | 'loopback_bridge'

export interface SignInFailureContext {
  provider: string
  error_class: string
  flow: FirebaseAuthFlow
  /** HTTP status when the failure came from an HTTP response. */
  error_status?: number
  retried_poll_errors?: number
}

/** Origin of a URL, or null when it isn't parseable (e.g. a view with no page). */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * True when `contents` is still on `expectedOrigin`. Guards the IndexedDB
 * injection, which writes the Firebase refresh token into whatever page is
 * currently loaded — a view that navigated away must never receive it.
 */
export function isOnOrigin(contents: WebContents, expectedOrigin: string): boolean {
  const current = originOf(contents.getURL())
  return current !== null && current === originOf(expectedOrigin)
}

/** Describe a sign-in failure for the local log. */
export function describeSignInFailure(
  provider: string,
  flow: FirebaseAuthFlow,
  error: Error,
  extra: Partial<Pick<SignInFailureContext, 'retried_poll_errors'>> = {}
): SignInFailureContext {
  const failure: SignInFailureContext = {
    provider,
    error_class: error.name || 'Error',
    flow,
    ...extra
  }
  // The raw message stays out (it can carry response bodies), but the HTTP
  // status is not sensitive and is the only thing that separates an old
  // backend (404) from a verifier mismatch (403) from a 5xx.
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
    failure.error_status = status
  }
  return failure
}

export interface HandleFirebasePopupOpts {
  /** Window restored after sign-in completes. */
  parentWindow?: BrowserWindow
  onError?: (failure: SignInFailureContext) => void
}

/** Keep in sync with the countdown rendered by the legacy bridge page. */
export const POST_SIGNIN_HOLD_MS = 3000
