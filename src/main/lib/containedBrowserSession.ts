import fs from 'fs'
import os from 'os'
import path from 'path'
import { session as electronSession } from 'electron'
import type { Session, WebContents } from 'electron'

/**
 * The session behind contained browser tabs.
 *
 * Kept separate from ComfyUI's and the launcher's own sessions (its own
 * persistent partition), so pages browsed in the apps overlay can't read the
 * launcher's storage and vice versa, while logins survive restarts.
 */

export const CONTAINED_BROWSER_PARTITION = 'persist:contained-browser'

/** Permissions a browsed page may use without asking. Everything else
 *  (camera, microphone, location, notifications, MIDI, USB…) is denied: a
 *  kiosk has no permission prompt UI and nobody to answer it. */
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write'])

export function isAllowedBrowserPermission(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission)
}

/**
 * Chromium's own UA without the `Electron/x` and app tokens. Several sites
 * (sign-in pages especially) refuse or degrade for UAs they don't recognise.
 */
export function chromeLikeUserAgent(ua: string): string {
  return ua
    .split(' ')
    .filter((token) => !/^(Electron|comfyui-desktop[\w-]*|Comfy[\w-]*)\//i.test(token))
    .join(' ')
}

/** `dir/name`, or `dir/name (n).ext` for the first n that doesn't exist. */
export function uniqueDownloadPath(
  dir: string,
  filename: string,
  exists: (p: string) => boolean = fs.existsSync
): string {
  const safe = path.basename(filename).replace(/[\\/]/g, '_') || 'download'
  const ext = path.extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  let candidate = path.join(dir, safe)
  for (let n = 1; exists(candidate); n++) candidate = path.join(dir, `${stem} (${n})${ext}`)
  return candidate
}

export interface DownloadNotice {
  webContents: WebContents
  filename: string
  savedPath: string | null
}

let configured: Session | null = null
let downloadListener: (notice: DownloadNotice) => void = () => {}

/** Where finished downloads are reported (the owning window's overlay). */
export function setContainedDownloadListener(listener: (notice: DownloadNotice) => void): void {
  downloadListener = listener
}

export function getContainedBrowserSession(): Session {
  if (configured) return configured
  const ses = electronSession.fromPartition(CONTAINED_BROWSER_PARTITION)
  ses.setUserAgent(chromeLikeUserAgent(ses.getUserAgent()))
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(isAllowedBrowserPermission(permission))
  })
  ses.setPermissionCheckHandler((_wc, permission) => isAllowedBrowserPermission(permission))

  // No save dialog: a dialog would be a separate window under the kiosk
  // compositor. Files go straight to ~/Downloads.
  ses.on('will-download', (_event, item, wc) => {
    const dir = path.join(os.homedir(), 'Downloads')
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      // Falls through to setSavePath, which fails the download visibly.
    }
    const target = uniqueDownloadPath(dir, item.getFilename())
    item.setSavePath(target)
    item.once('done', (_e, state) => {
      if (!wc || wc.isDestroyed()) return
      downloadListener({
        webContents: wc,
        filename: path.basename(target),
        savedPath: state === 'completed' ? target : null
      })
    })
  })
  configured = ses
  return ses
}
