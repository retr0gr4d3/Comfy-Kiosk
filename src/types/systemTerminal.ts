/** Contract between the system terminal overlay renderer and its preload. */

export interface SystemTerminalRestore {
  buffer: string[]
  size: { cols: number; rows: number }
  exited: boolean
}

/** Localized header copy main pushes with every show. */
export interface SystemTerminalShowPayload {
  title: string
  hint: string
  close: string
}

export interface SystemTerminalBridge {
  platform: string
  /** Renderer mounted; main shows the overlay if an open was waiting on it. */
  ready(): void
  /** Attach to the shared shell (spawning it if needed); returns scrollback. */
  subscribe(): Promise<SystemTerminalRestore | null>
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Ask main to close the overlay (e.g. the header's close button). */
  requestClose(): void
  /** Exit animation finished; main hides the view. */
  notifyHidden(): void
  onShow(cb: (payload: SystemTerminalShowPayload) => void): () => void
  onHide(cb: () => void): () => void
  onOutput(cb: (data: string) => void): () => void
  onExited(cb: () => void): () => void
}
