import { app } from 'electron'
import { writeAppLogSync, flushOperationOutput } from './appLog'

/**
 * Main-process error funnel: record uncaught errors and crashed child /
 * renderer processes in the local app log. Nothing leaves the machine.
 */

let processErrorHandlersRegistered = false

function serializeUnknownError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || 'Error',
      stack: error.stack
    }
  }
  if (typeof error === 'string') {
    return { message: error }
  }
  if (error === null || error === undefined) {
    return { message: 'Unknown error' }
  }
  try {
    return { message: JSON.stringify(error) }
  } catch {
    return { message: String(error) }
  }
}

export function registerProcessErrorHandlers(): void {
  if (processErrorHandlersRegistered) return
  processErrorHandlersRegistered = true

  process.on('uncaughtExceptionMonitor', (error) => {
    const serialized = serializeUnknownError(error)
    // Synchronous write first: a buffered stream write would be lost when the
    // process dies before flushing, and this is exactly the cause we need.
    writeAppLogSync(
      'CRITICAL',
      `uncaughtException: ${serialized.message}${serialized.stack ? `\n${serialized.stack}` : ''}`
    )
    // The process is about to die: flush any buffered operation/session tails
    // (install/update/migrate output that hasn't hit a newline) so the last
    // lines before the crash are durable. No-rotate to match the crash path.
    flushOperationOutput(undefined, { rotate: false })
  })

  process.on('unhandledRejection', (reason) => {
    const serialized = serializeUnknownError(reason)
    writeAppLogSync(
      'ERROR',
      `unhandledRejection: ${serialized.message}${serialized.stack ? `\n${serialized.stack}` : ''}`
    )
  })

  app.on('child-process-gone', (_event, details) => {
    const extra = details as unknown as Record<string, unknown>
    // Captures GPU / utility / pepper-plugin crashes — native faults that
    // never surface as a JS exception and are a prime suspect for
    // "spontaneously crashes after a few seconds" reports.
    writeAppLogSync(
      details.reason === 'clean-exit' ? 'INFO' : 'ERROR',
      `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}` +
        `${extra['name'] ? ` name=${String(extra['name'])}` : ''}` +
        `${extra['serviceName'] ? ` service=${String(extra['serviceName'])}` : ''}`
    )
  })

  app.on('render-process-gone', (_event, _webContents, details) => {
    // Renderer crashes (Vue UI dying, OOM, integrity failure) are a separate
    // event from child-process-gone and were not previously captured at the
    // app level. `clean-exit` is normal teardown, so don't treat it as a fault.
    if (details.reason === 'clean-exit') return
    writeAppLogSync(
      'CRITICAL',
      `render-process-gone reason=${details.reason} exitCode=${details.exitCode}`
    )
  })
}
