import fs from 'fs'
import path from 'path'
import type { AppEntry } from '../../types/appsOverlay'
import { isNavigableUrl } from '../../shared/browserUrl'
import { configDir } from './paths'

/**
 * Apps offered by the in-window launcher (Ctrl+Alt+A).
 *
 * The Browser and Terminal are always present. Web apps come from
 * `<configDir>/apps.json`, so a kiosk image can ship its own set:
 *
 *   {
 *     "browser": {
 *       "homeUrl": "https://start.duckduckgo.com",
 *       "searchUrl": "https://duckduckgo.com/?q=%s"
 *     },
 *     "apps": [
 *       { "id": "docs", "name": "ComfyUI Docs", "url": "https://docs.comfy.org" }
 *     ]
 *   }
 *
 * An `apps` array replaces the defaults (an empty array means none). Entries
 * that aren't http(s) URLs are dropped. A missing or unreadable file uses the
 * defaults. Read on every launcher open, so edits apply without a restart.
 */

export interface AppsConfig {
  homeUrl: string
  searchTemplate: string
  apps: AppEntry[]
}

export const APPS_CONFIG_FILE = 'apps.json'

const DEFAULT_HOME_URL = 'https://start.duckduckgo.com/'
const DEFAULT_SEARCH_TEMPLATE = 'https://duckduckgo.com/?q=%s'

const DEFAULT_WEB_APPS: AppEntry[] = [
  { id: 'web:comfy-docs', name: 'ComfyUI Docs', kind: 'web', url: 'https://docs.comfy.org/' },
  { id: 'web:hugging-face', name: 'Hugging Face', kind: 'web', url: 'https://huggingface.co/' }
]

export const BUILTIN_APPS: AppEntry[] = [
  { id: 'browser', name: 'Browser', kind: 'browser' },
  { id: 'terminal', name: 'Terminal', kind: 'terminal' }
]

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseWebApps(value: unknown): AppEntry[] {
  if (!Array.isArray(value)) return DEFAULT_WEB_APPS
  const seen = new Set(BUILTIN_APPS.map((a) => a.id))
  const apps: AppEntry[] = []
  for (const item of value) {
    const rec = asRecord(item)
    if (!rec) continue
    const { name, url } = rec
    if (typeof name !== 'string' || !name.trim()) continue
    if (typeof url !== 'string' || !isNavigableUrl(url) || url === 'about:blank') continue
    const rawId = typeof rec['id'] === 'string' && rec['id'].trim() ? rec['id'].trim() : name
    const id = `web:${rawId}`
    if (seen.has(id)) continue
    seen.add(id)
    apps.push({ id, name: name.trim(), kind: 'web', url: new URL(url).toString() })
  }
  return apps
}

export function parseAppsConfig(raw: unknown): AppsConfig {
  const root = asRecord(raw) ?? {}
  const browser = asRecord(root['browser']) ?? {}
  const home = browser['homeUrl']
  const search = browser['searchUrl']
  return {
    homeUrl: typeof home === 'string' && isNavigableUrl(home) ? home : DEFAULT_HOME_URL,
    searchTemplate:
      typeof search === 'string' &&
      search.includes('%s') &&
      isNavigableUrl(search.replace('%s', 'q'))
        ? search
        : DEFAULT_SEARCH_TEMPLATE,
    apps: [...BUILTIN_APPS, ...parseWebApps(root['apps'])]
  }
}

export function loadAppsConfig(dir: string = configDir()): AppsConfig {
  try {
    const text = fs.readFileSync(path.join(dir, APPS_CONFIG_FILE), 'utf-8')
    return parseAppsConfig(JSON.parse(text))
  } catch {
    return parseAppsConfig(null)
  }
}
