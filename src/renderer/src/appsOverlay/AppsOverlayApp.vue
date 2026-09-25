<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  LayoutGrid,
  LoaderCircle,
  Plus,
  RotateCw,
  SquareTerminal,
  TriangleAlert,
  X
} from 'lucide-vue-next'
import type {
  AppEntry,
  AppsOverlayBridge,
  AppsOverlayState,
  AppsOverlayStrings,
  BrowserTabState
} from '../../../types/appsOverlay'
import { displayAddress } from '../../../shared/browserUrl'
import { matchBrowserShortcut } from '../../../shared/browserShortcuts'

/**
 * The apps overlay: a launcher grid and the contained browser's chrome (tab
 * strip, toolbar, error panel). Browsed pages are separate views main lays
 * over the `.ao-content` area this component measures and reports, so that
 * area stays empty while a page is showing.
 */

const bridge = (window as unknown as { appsOverlay?: AppsOverlayBridge }).appsOverlay

const strings = ref<AppsOverlayStrings>({
  title: 'Apps',
  hint: 'Ctrl+Alt+A',
  close: 'Close',
  newTab: 'New tab',
  closeTab: 'Close tab',
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  stop: 'Stop',
  addressPlaceholder: 'Search or enter address',
  loadFailed: "This page couldn't be loaded",
  retry: 'Try again',
  launcherHeading: 'Apps',
  untitled: 'New tab'
})
const state = ref<AppsOverlayState>({
  apps: [],
  tabs: [],
  activeTabId: null,
  notice: null,
  searchTemplate: ''
})
const visible = ref(false)
const address = ref('')
const addressFocused = ref(false)
const contentRef = ref<HTMLDivElement | null>(null)
const addressRef = ref<HTMLInputElement | null>(null)

const activeTab = computed<BrowserTabState | null>(
  () => state.value.tabs.find((t) => t.id === state.value.activeTabId) ?? null
)

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function tabLabel(tab: BrowserTabState): string {
  return tab.title || hostOf(tab.url) || strings.value.untitled
}

function appInitial(app: AppEntry): string {
  return app.name.trim().charAt(0).toUpperCase() || '?'
}

// Keep the address bar on the page's URL, except while the user is editing.
watch(
  () => [activeTab.value?.id, activeTab.value?.url] as const,
  ([id], [prevId]) => {
    if (addressFocused.value && id === prevId) return
    address.value = displayAddress(activeTab.value?.url ?? '')
  }
)

let rectFrame = 0
function reportContentRect(): void {
  cancelAnimationFrame(rectFrame)
  rectFrame = requestAnimationFrame(() => {
    const el = contentRef.value
    if (!el || !bridge) return
    const r = el.getBoundingClientRect()
    bridge.setContentRect({ x: r.left, y: r.top, width: r.width, height: r.height })
  })
}

// The toolbar comes and goes with the launcher, moving the page area.
watch(
  () => [activeTab.value !== null, visible.value] as const,
  () => void nextTick(reportContentRect)
)

function openApp(app: AppEntry): void {
  bridge?.openApp(app.id)
}

function submitAddress(): void {
  const tab = activeTab.value
  if (!tab || !address.value.trim()) return
  bridge?.navigate(tab.id, address.value)
  addressRef.value?.blur()
}

function onAddressKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  address.value = displayAddress(activeTab.value?.url ?? '')
  addressRef.value?.blur()
  bridge?.focusPage()
}

function focusAddress(): void {
  if (!activeTab.value) return
  addressRef.value?.focus()
  addressRef.value?.select()
}

function onKeydown(e: KeyboardEvent): void {
  const action = matchBrowserShortcut({
    type: 'keydown',
    key: e.key,
    control: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    meta: e.metaKey
  })
  if (!action) return
  e.preventDefault()
  if (action === 'focus-address') focusAddress()
  else bridge?.shortcut(action)
}

const disposers: Array<() => void> = []
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (!bridge) return
  disposers.push(
    bridge.onShow((s) => {
      strings.value = s
      visible.value = true
      void nextTick(reportContentRect)
    }),
    bridge.onState((s) => {
      state.value = s
    }),
    bridge.onFocusAddress(() => void nextTick(focusAddress))
  )
  window.addEventListener('keydown', onKeydown, true)
  disposers.push(() => window.removeEventListener('keydown', onKeydown, true))
  resizeObserver = new ResizeObserver(reportContentRect)
  if (contentRef.value) resizeObserver.observe(contentRef.value)
  bridge.ready()
})

onBeforeUnmount(() => {
  for (const dispose of disposers.splice(0)) dispose()
  resizeObserver?.disconnect()
  cancelAnimationFrame(rectFrame)
})
</script>

<template>
  <div class="ao-root" :class="{ 'ao-root--visible': visible }" data-testid="apps-overlay">
    <div class="ao-backdrop" @mousedown.self="bridge?.requestClose()" />
    <section class="ao-sheet" role="dialog" :aria-label="strings.title">
      <header class="ao-header">
        <button
          type="button"
          class="ao-home"
          :class="{ 'is-active': state.activeTabId === null }"
          data-testid="apps-home"
          @click="bridge?.activateTab(null)"
        >
          <LayoutGrid :size="14" aria-hidden="true" />
          <span>{{ strings.title }}</span>
        </button>
        <div class="ao-tablist" role="tablist">
          <div
            v-for="tab in state.tabs"
            :key="tab.id"
            class="ao-tab"
            :class="{ 'is-active': tab.id === state.activeTabId }"
            role="tab"
            :aria-selected="tab.id === state.activeTabId"
            :title="tab.url"
            data-testid="apps-tab"
            @click="bridge?.activateTab(tab.id)"
            @auxclick.middle="bridge?.closeTab(tab.id)"
          >
            <LoaderCircle v-if="tab.loading" :size="12" class="ao-spin" aria-hidden="true" />
            <Globe v-else :size="12" aria-hidden="true" />
            <span class="ao-tab-title">{{ tabLabel(tab) }}</span>
            <button
              type="button"
              class="ao-tab-close"
              :aria-label="strings.closeTab"
              :title="strings.closeTab"
              @click.stop="bridge?.closeTab(tab.id)"
            >
              <X :size="12" aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            class="ao-icon-btn"
            :aria-label="strings.newTab"
            :title="strings.newTab"
            data-testid="apps-new-tab"
            @click="bridge?.newTab()"
          >
            <Plus :size="14" aria-hidden="true" />
          </button>
        </div>
        <!-- Notices live in the header: the page area below is covered by
             the page view whenever a tab is showing. -->
        <span
          v-if="state.notice"
          class="ao-hint ao-hint--notice"
          role="status"
          data-testid="apps-notice"
          >{{ state.notice }}</span
        >
        <span v-else class="ao-hint">{{ strings.hint }}</span>
        <button
          type="button"
          class="ao-icon-btn"
          :aria-label="strings.close"
          :title="strings.close"
          data-testid="apps-close"
          @click="bridge?.requestClose()"
        >
          <X :size="14" aria-hidden="true" />
        </button>
      </header>

      <div v-if="activeTab" class="ao-toolbar">
        <button
          type="button"
          class="ao-icon-btn"
          :disabled="!activeTab.canGoBack"
          :aria-label="strings.back"
          :title="strings.back"
          @click="bridge?.back(activeTab.id)"
        >
          <ArrowLeft :size="15" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="ao-icon-btn"
          :disabled="!activeTab.canGoForward"
          :aria-label="strings.forward"
          :title="strings.forward"
          @click="bridge?.forward(activeTab.id)"
        >
          <ArrowRight :size="15" aria-hidden="true" />
        </button>
        <button
          v-if="activeTab.loading"
          type="button"
          class="ao-icon-btn"
          :aria-label="strings.stop"
          :title="strings.stop"
          @click="bridge?.stop(activeTab.id)"
        >
          <X :size="15" aria-hidden="true" />
        </button>
        <button
          v-else
          type="button"
          class="ao-icon-btn"
          :aria-label="strings.reload"
          :title="strings.reload"
          @click="bridge?.reload(activeTab.id)"
        >
          <RotateCw :size="14" aria-hidden="true" />
        </button>
        <form class="ao-address" @submit.prevent="submitAddress">
          <input
            ref="addressRef"
            v-model="address"
            type="text"
            spellcheck="false"
            autocomplete="off"
            :placeholder="strings.addressPlaceholder"
            :aria-label="strings.addressPlaceholder"
            data-testid="apps-address"
            @focus="addressFocused = true"
            @blur="addressFocused = false"
            @keydown="onAddressKeydown"
          />
        </form>
      </div>

      <div class="ao-content">
        <!-- The page view is laid over this slot. -->
        <div ref="contentRef" class="ao-page-slot" aria-hidden="true" />
        <div v-if="!activeTab" class="ao-launcher" data-testid="apps-launcher">
          <h2 class="ao-launcher-heading">{{ strings.launcherHeading }}</h2>
          <div class="ao-grid">
            <button
              v-for="app in state.apps"
              :key="app.id"
              type="button"
              class="ao-tile"
              :data-app-id="app.id"
              :title="app.url ?? app.name"
              @click="openApp(app)"
            >
              <span class="ao-tile-icon" :class="`ao-tile-icon--${app.kind}`" aria-hidden="true">
                <Globe v-if="app.kind === 'browser'" :size="26" />
                <SquareTerminal v-else-if="app.kind === 'terminal'" :size="26" />
                <span v-else class="ao-tile-initial">{{ appInitial(app) }}</span>
              </span>
              <span class="ao-tile-name">{{ app.name }}</span>
              <span v-if="app.url" class="ao-tile-host">{{ hostOf(app.url) }}</span>
            </button>
          </div>
        </div>
        <div v-else-if="activeTab.error" class="ao-error" role="alert" data-testid="apps-error">
          <TriangleAlert :size="28" aria-hidden="true" />
          <p class="ao-error-title">{{ strings.loadFailed }}</p>
          <p class="ao-error-detail">{{ activeTab.url }} — {{ activeTab.error }}</p>
          <button type="button" class="accent ao-error-retry" @click="bridge?.reload(activeTab.id)">
            {{ strings.retry }}
          </button>
        </div>
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
.ao-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity 120ms ease;
}

.ao-root--visible {
  pointer-events: auto;
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .ao-root {
    transition: none;
  }
}

.ao-backdrop {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--neutral-950) 55%, transparent);
}

.ao-sheet {
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
}

button {
  font: inherit;
}

.ao-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 8px;
  background: color-mix(in srgb, var(--neutral-800) 72%, transparent);
  border-bottom: 1px solid var(--chooser-surface-border);
}

.ao-home {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  flex-shrink: 0;
}

.ao-home:hover,
.ao-home.is-active {
  background: var(--chooser-surface-bg-hover);
  color: var(--text);
}

.ao-tablist {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 1 1 auto;
  overflow-x: auto;
  scrollbar-width: none;
}

.ao-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  min-width: 0;
  max-width: 200px;
  flex: 0 1 200px;
  padding: 0 4px 0 10px;
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.ao-tab:hover {
  background: var(--chooser-surface-bg);
}

.ao-tab.is-active {
  background: var(--chooser-surface-bg-hover);
  color: var(--text);
}

.ao-tab-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ao-tab-close,
.ao-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.ao-tab-close {
  width: 18px;
  height: 18px;
}

.ao-icon-btn {
  width: 26px;
  height: 26px;
}

.ao-tab-close:hover,
.ao-icon-btn:hover:not(:disabled),
.ao-icon-btn:focus-visible {
  background: var(--chooser-surface-bg-hover);
  color: var(--text);
}

.ao-icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.ao-hint {
  flex-shrink: 0;
  font-size: 11px;
  color: color-mix(in srgb, var(--text-muted) 70%, transparent);
  white-space: nowrap;
}

.ao-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 40px;
  padding: 0 8px;
  border-bottom: 1px solid var(--chooser-surface-border);
}

.ao-address {
  flex: 1 1 auto;
  min-width: 0;
  margin-left: 4px;
}

.ao-address input {
  width: 100%;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 14px;
  background: var(--chooser-surface-bg);
  color: var(--text);
  font-size: 12px;
  outline: none;
}

.ao-address input:focus {
  border-color: var(--chooser-surface-border-hover);
  background: var(--chooser-surface-bg-hover);
}

.ao-content {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

/* Inset so the page view, rounded to match, sits inside the sheet's own
 * rounded corners instead of poking past them. */
.ao-page-slot {
  position: absolute;
  inset: 6px;
  pointer-events: none;
}

.ao-launcher {
  max-width: 880px;
  margin: 0 auto;
  padding: 32px 24px;
}

.ao-launcher-heading {
  margin: 0 0 20px;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.ao-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 12px;
}

.ao-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 18px 10px 14px;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 10px;
  background: var(--chooser-surface-bg);
  color: var(--text);
  cursor: pointer;
  min-width: 0;
}

.ao-tile:hover,
.ao-tile:focus-visible {
  background: var(--chooser-surface-bg-hover);
  border-color: var(--chooser-surface-border-hover);
  outline: none;
}

.ao-tile-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--neutral-950) 45%, transparent);
  color: var(--text);
}

.ao-tile-icon--web {
  background: color-mix(in srgb, var(--accent-plum, #afa3db) 22%, transparent);
}

.ao-tile-initial {
  font-size: 20px;
  font-weight: 600;
}

.ao-tile-name {
  max-width: 100%;
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ao-tile-host {
  max-width: 100%;
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ao-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  padding: 24px;
  color: var(--text-muted);
  text-align: center;
}

.ao-error-title {
  margin: 4px 0 0;
  font-size: 14px;
  color: var(--text);
}

.ao-error-detail {
  margin: 0;
  max-width: 560px;
  font-size: 12px;
  word-break: break-all;
}

.ao-error-retry {
  margin-top: 8px;
  height: 30px;
  padding: 0 14px;
  font-size: 12px;
  border-radius: 8px;
}

.ao-hint--notice {
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}

.ao-spin {
  animation: ao-spin 900ms linear infinite;
}

@keyframes ao-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
