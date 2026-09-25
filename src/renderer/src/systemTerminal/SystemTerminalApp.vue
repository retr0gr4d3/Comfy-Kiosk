<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { X } from 'lucide-vue-next'
import type { SystemTerminalBridge, SystemTerminalRestore } from '../../../types/systemTerminal'
import { normalizePlatform } from '../composables/usePlatform'
import { decideTerminalKeyAction } from '../../../shared/terminalShortcuts'

/**
 * The Ctrl+Alt+T system terminal. Drawn as a sheet that drops down over the
 * window body (the title bar stays visible above it), in the app's own
 * surface tokens, so it reads as part of Comfy Desktop rather than a
 * separate program.
 *
 * The webContents persists between opens: the xterm instance is built once
 * and re-attached to the shared shell whenever that shell was restarted.
 * Main drives visibility with `show` / `hide`; `hide` plays the exit
 * animation and acks with `notifyHidden()` so main can hide the view.
 */

const bridge = (window as unknown as { systemTerminal?: SystemTerminalBridge }).systemTerminal

const EXIT_ANIMATION_MS = 140

const hostRef = ref<HTMLDivElement | null>(null)
const visible = ref(false)
/** Attached to a live shell and focused: keystrokes reach the shell. */
const ready = ref(false)
const title = ref('Terminal')
const hint = ref('Ctrl+Alt+T')
const closeLabel = ref('Close')

const platform = normalizePlatform(bridge?.platform)

let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
/** True while attached to a live shell; false before first open and after `exit`. */
let attached = false
let attachInFlight: Promise<void> | null = null
/** Keystrokes typed before the shell attached (the first open spawns it),
 *  flushed once it is up so nothing typed right after Ctrl+Alt+T is lost. */
let pendingInput = ''
let hideTimer: ReturnType<typeof setTimeout> | null = null
const disposers: Array<() => void> = []

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function createTerminal(host: HTMLElement): Terminal {
  const bg = cssVar('--neutral-800', '#211927')
  const fg = cssVar('--neutral-100', '#c2bfb9')
  const term = new Terminal({
    allowProposedApi: false,
    cursorBlink: true,
    fontFamily:
      "'Cascadia Mono', 'JetBrains Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', ui-monospace, monospace",
    fontSize: 13,
    lineHeight: 1.3,
    scrollback: 5000,
    theme: {
      background: bg,
      foreground: fg,
      cursor: cssVar('--neutral-200', '#a6a2a1'),
      cursorAccent: bg,
      selectionBackground: cssVar('--terminal-selection', 'rgba(11, 140, 233, 0.28)'),
      black: cssVar('--neutral-950', '#100c13'),
      red: cssVar('--danger', '#e05858'),
      green: cssVar('--success', '#00cd72'),
      yellow: cssVar('--warning', '#fd9903'),
      blue: cssVar('--info', '#58a6ff'),
      magenta: cssVar('--accent-plum', '#afa3db'),
      cyan: cssVar('--info', '#58a6ff'),
      white: fg,
      brightBlack: cssVar('--neutral-400', '#6f6970'),
      brightRed: cssVar('--danger-hover', '#ef6b6b'),
      brightGreen: cssVar('--success', '#00cd72'),
      brightYellow: cssVar('--warning', '#fd9903'),
      brightBlue: cssVar('--accent-hover', '#93c5fd'),
      brightMagenta: cssVar('--accent-plum', '#afa3db'),
      brightCyan: cssVar('--accent-hover', '#93c5fd'),
      brightWhite: cssVar('--text', '#ffffff')
    }
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(host)

  // Copy/paste chords per OS (Ctrl+Shift+C/V on Linux) must not leak control
  // bytes into the shell. Ctrl+Alt+T itself never reaches here: main
  // intercepts it before the page sees it.
  term.attachCustomKeyEventHandler((e) => {
    const action = decideTerminalKeyAction(e, platform, term.hasSelection())
    if (action === 'copy') {
      const text = term.getSelection()
      if (text) void navigator.clipboard.writeText(text).catch(() => {})
      return false
    }
    // Paste arrives through the browser's native paste event; only swallow the key.
    if (action === 'paste' || action === 'swallow') return false
    return true
  })

  disposers.push(
    term.onData((data) => {
      if (attached) bridge?.write(data)
      else pendingInput += data
    }).dispose
  )
  return term
}

/** Fit xterm to the sheet and tell the shell. `force` re-sends even when the
 *  size is unchanged, reclaiming the shared PTY from another window. */
function fit(force = false): void {
  if (!terminal || !fitAddon || !visible.value) return
  const dims = fitAddon.proposeDimensions()
  if (!dims || !dims.cols || !dims.rows) return
  const changed = dims.cols !== terminal.cols || dims.rows !== terminal.rows
  if (changed) terminal.resize(dims.cols, dims.rows)
  if (changed || force) bridge?.resize(dims.cols, dims.rows)
}

function applyRestore(restore: SystemTerminalRestore): void {
  if (!terminal) return
  terminal.reset()
  if (restore.buffer.length) terminal.write(restore.buffer.join(''))
}

async function attach(): Promise<void> {
  if (attached || !bridge) return
  attachInFlight ??= (async () => {
    const restore = await bridge.subscribe()
    if (!restore) return
    applyRestore(restore)
    attached = true
    if (pendingInput) {
      bridge.write(pendingInput)
      pendingInput = ''
    }
  })().finally(() => {
    attachInFlight = null
  })
  await attachInFlight
}

async function onShow(): Promise<void> {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  visible.value = true
  // Focus first so keystrokes typed while the shell spawns are captured.
  terminal?.focus()
  // Let the sheet take its size before measuring.
  await new Promise((resolve) => requestAnimationFrame(resolve))
  fit(true)
  await attach()
  fit(true)
  terminal?.focus()
  ready.value = visible.value && attached
}

function onHide(): void {
  visible.value = false
  ready.value = false
  terminal?.blur()
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    hideTimer = null
    bridge?.notifyHidden()
  }, EXIT_ANIMATION_MS)
}

function requestClose(): void {
  bridge?.requestClose()
}

onMounted(() => {
  if (!hostRef.value || !bridge) return
  terminal = createTerminal(hostRef.value)

  disposers.push(
    bridge.onShow((payload) => {
      title.value = payload.title
      hint.value = payload.hint
      closeLabel.value = payload.close
      void onShow()
    }),
    bridge.onHide(onHide),
    bridge.onOutput((data) => terminal?.write(data)),
    // The shell ended (`exit`); main closes the sheet. The next show spawns
    // and attaches a fresh shell.
    bridge.onExited(() => {
      attached = false
      ready.value = false
    })
  )

  resizeObserver = new ResizeObserver(() => fit())
  resizeObserver.observe(hostRef.value)

  bridge.ready()
})

onBeforeUnmount(() => {
  for (const dispose of disposers.splice(0)) dispose()
  resizeObserver?.disconnect()
  if (hideTimer) clearTimeout(hideTimer)
  terminal?.dispose()
  terminal = null
})
</script>

<template>
  <div
    class="st-root"
    :class="{ 'st-root--visible': visible }"
    :data-ready="ready ? 'true' : 'false'"
    data-testid="system-terminal"
  >
    <div class="st-backdrop" @mousedown.self="requestClose" />
    <section class="st-sheet" role="dialog" :aria-label="title">
      <header class="st-header">
        <span class="st-dots" aria-hidden="true"><span /><span /><span /></span>
        <span class="st-title">{{ title }}</span>
        <span class="st-hint">{{ hint }}</span>
        <button
          type="button"
          class="st-close"
          :aria-label="closeLabel"
          :title="closeLabel"
          data-testid="system-terminal-close"
          @click="requestClose"
        >
          <X :size="14" aria-hidden="true" />
        </button>
      </header>
      <div class="st-viewport">
        <div ref="hostRef" class="st-host" />
      </div>
    </section>
  </div>
</template>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
  background: transparent;
  overflow: hidden;
}
</style>

<style scoped>
.st-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
}

.st-root--visible {
  pointer-events: auto;
}

/* The canvas stays faintly visible behind the sheet, like the app's other
 * body-level overlays. */
.st-backdrop {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--neutral-950) 55%, transparent);
  opacity: 0;
  transition: opacity 140ms ease;
}

.st-root--visible .st-backdrop {
  opacity: 1;
}

.st-sheet {
  position: absolute;
  inset: 8px 10px 10px;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--neutral-800);
  border: 1px solid var(--chooser-surface-border);
  border-radius: 10px;
  overflow: hidden;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--neutral-950) 35%, transparent),
    0 16px 40px color-mix(in srgb, var(--neutral-950) 45%, transparent);
  opacity: 0;
  transform: translateY(-14px);
  transition:
    opacity 140ms ease,
    transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.st-root--visible .st-sheet {
  opacity: 1;
  transform: none;
}

@media (prefers-reduced-motion: reduce) {
  .st-sheet,
  .st-backdrop {
    transition: none;
  }
}

.st-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 8px 0 14px;
  background: color-mix(in srgb, var(--neutral-800) 72%, transparent);
  border-bottom: 1px solid var(--chooser-surface-border);
}

.st-dots {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.st-dots span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--neutral-400) 42%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, white 8%, transparent);
}

.st-title {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--text-muted) 88%, transparent);
}

.st-hint {
  margin-left: auto;
  font-size: 11px;
  color: color-mix(in srgb, var(--text-muted) 70%, transparent);
}

.st-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.st-close:hover,
.st-close:focus-visible {
  background: var(--chooser-surface-bg-hover);
  color: var(--text);
}

.st-viewport {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  background: var(--neutral-800);
}

/* Absolute so xterm's intrinsic size never drives layout. content-box so
 * FitAddon measures the inner area, excluding padding. */
.st-host {
  position: absolute;
  inset: 0;
  box-sizing: content-box;
  padding: 10px 12px 12px;
  overflow: hidden;
}

.st-host :deep(.xterm) {
  height: 100%;
  overflow: hidden;
}

.st-host :deep(.xterm-viewport) {
  background-color: transparent;
}

.st-host :deep(.xterm-screen) {
  overflow: hidden;
  background-color: var(--neutral-800);
}
</style>
