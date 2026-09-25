import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./paths', () => ({ configDir: () => '/nonexistent' }))

import { BUILTIN_APPS, loadAppsConfig, parseAppsConfig } from './appsConfig'

describe('parseAppsConfig', () => {
  it('falls back to defaults for missing or malformed config', () => {
    for (const raw of [null, 'x', [], { browser: 5, apps: 'nope' }]) {
      const config = parseAppsConfig(raw)
      expect(config.homeUrl).toMatch(/^https:\/\//)
      expect(config.searchTemplate).toContain('%s')
      expect(config.apps.slice(0, 2)).toEqual(BUILTIN_APPS)
      expect(config.apps.length).toBeGreaterThan(2)
    }
  })

  it('reads the browser home and search URLs', () => {
    const config = parseAppsConfig({
      browser: { homeUrl: 'http://127.0.0.1:8188/', searchUrl: 'https://s.example/?q=%s' }
    })
    expect(config.homeUrl).toBe('http://127.0.0.1:8188/')
    expect(config.searchTemplate).toBe('https://s.example/?q=%s')
  })

  it('rejects a search URL without %s or with a refused scheme', () => {
    expect(
      parseAppsConfig({ browser: { searchUrl: 'https://s.example/' } }).searchTemplate
    ).not.toBe('https://s.example/')
    expect(parseAppsConfig({ browser: { homeUrl: 'file:///' } }).homeUrl).not.toBe('file:///')
  })

  it('replaces the default web apps with the configured ones, keeping built-ins first', () => {
    const config = parseAppsConfig({
      apps: [
        { id: 'grafana', name: ' Grafana ', url: 'http://localhost:3000' },
        { name: 'Wiki', url: 'https://wiki.example/' }
      ]
    })
    expect(config.apps).toEqual([
      ...BUILTIN_APPS,
      { id: 'web:grafana', name: 'Grafana', kind: 'web', url: 'http://localhost:3000/' },
      { id: 'web:Wiki', name: 'Wiki', kind: 'web', url: 'https://wiki.example/' }
    ])
  })

  it('drops invalid entries and duplicates', () => {
    const config = parseAppsConfig({
      apps: [
        { name: 'Files', url: 'file:///home' },
        { name: 'Script', url: 'javascript:alert(1)' },
        { name: '', url: 'https://a.example/' },
        { name: 'No URL' },
        'string entry',
        { id: 'a', name: 'A', url: 'https://a.example/' },
        { id: 'a', name: 'A again', url: 'https://b.example/' }
      ]
    })
    expect(config.apps.map((a) => a.id)).toEqual(['browser', 'terminal', 'web:a'])
  })

  it('treats an empty apps array as "no web apps"', () => {
    expect(parseAppsConfig({ apps: [] }).apps).toEqual(BUILTIN_APPS)
  })
})

describe('loadAppsConfig', () => {
  let dir = ''
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads apps.json from the config dir', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-config-'))
    fs.writeFileSync(
      path.join(dir, 'apps.json'),
      JSON.stringify({ apps: [{ id: 'x', name: 'X', url: 'https://x.example/' }] })
    )
    expect(loadAppsConfig(dir).apps.map((a) => a.id)).toEqual(['browser', 'terminal', 'web:x'])
  })

  it('uses defaults when the file is missing or corrupt', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-config-'))
    expect(loadAppsConfig(dir)).toEqual(parseAppsConfig(null))
    fs.writeFileSync(path.join(dir, 'apps.json'), '{nope')
    expect(loadAppsConfig(dir)).toEqual(parseAppsConfig(null))
  })
})
