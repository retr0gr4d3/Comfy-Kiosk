import { defineStore } from 'pinia'
import { computed, reactive } from 'vue'
import type { ModelDownloadProgress, Unsubscribe } from '../types/ipc'

export const useDownloadStore = defineStore('downloads', () => {
  // Rows keyed by the download's stable job id, falling back to its URL for
  // rows from mains that predate ids.
  const downloads = reactive(new Map<string, ModelDownloadProgress>())
  // Active main-process subscriptions; also gates the idempotent `init()`.
  const unsubs: Unsubscribe[] = []

  function rowKey(progress: ModelDownloadProgress): string {
    return progress.id ?? progress.url
  }

  /** Drop the row addressed by `ref` (job id or URL). Falls back to scanning
   *  for a URL match so removal broadcasts that only carry a URL still drop
   *  id-keyed rows. */
  function removeByRef(ref: string): void {
    if (downloads.delete(ref)) return
    for (const [key, d] of downloads) {
      if (d.url === ref || d.id === ref) {
        downloads.delete(key)
        return
      }
    }
  }

  function upsert(progress: ModelDownloadProgress): void {
    downloads.set(rowKey(progress), { ...progress })
  }

  function init(): void {
    if (unsubs.length > 0) return

    // Seed with in-flight + recently-finished downloads so surfaces are non-empty on first paint.
    window.api.listModelDownloads().then((list) => {
      for (const p of list) upsert(p)
    })

    // Source of truth lives in main so dismissals propagate across every surface (popup ↔ Settings tab).
    unsubs.push(
      window.api.onModelDownloadProgress((p) => upsert(p)),
      window.api.onModelDownloadRemoved(({ url, id }) => {
        removeByRef(id ?? url)
      }),
      window.api.onModelDownloadsClearedFinished(({ urls, refs }) => {
        for (const ref of refs ?? urls) removeByRef(ref)
      })
    )
  }

  // Routes through main; local state updates via the `model-download-removed` listener, not here, so surfaces stay in lockstep.
  function dismiss(ref: string): void {
    void window.api.dismissModelDownload(ref)
  }

  function clearFinished(): void {
    void window.api.clearFinishedModelDownloads()
  }

  const activeDownloads = computed(() => {
    const result: ModelDownloadProgress[] = []
    downloads.forEach((d) => {
      if (d.status === 'pending' || d.status === 'downloading' || d.status === 'paused') {
        result.push(d)
      }
    })
    return result
  })

  const finishedDownloads = computed(() => {
    const result: ModelDownloadProgress[] = []
    downloads.forEach((d) => {
      if (d.status === 'completed' || d.status === 'error' || d.status === 'cancelled') {
        result.push(d)
      }
    })
    return result
  })

  const hasDownloads = computed(() => downloads.size > 0)

  return {
    downloads,
    init,
    upsert,
    dismiss,
    clearFinished,
    activeDownloads,
    finishedDownloads,
    hasDownloads
  }
})
