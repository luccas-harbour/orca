import type { WebContents } from 'electron'
import { BrowserError } from './cdp-bridge'
import { settleBeforeDeadline } from '../runtime/settle-before-deadline'

export const BROWSER_EVALUATION_CANCEL_TIMEOUT_MS = 1_000
const failedCancellations = new WeakMap<WebContents, BrowserError>()

export function assertBrowserPageEvaluationAvailable(guest: WebContents): void {
  const failure = failedCancellations.get(guest)
  if (failure) {
    throw failure
  }
}

async function cancelBrowserPageEvaluation(
  guest: WebContents,
  isCurrentDocument: () => boolean
): Promise<void> {
  if (guest.isDestroyed()) {
    return
  }
  const failure = new BrowserError(
    'browser_error',
    'The page script could not be stopped. Reload this tab or navigate to a different page to recover.'
  )
  failedCancellations.set(guest, failure)
  const clearFailure = (): void => {
    if (failedCancellations.get(guest) === failure) {
      failedCancellations.delete(guest)
    }
    guest.removeListener('did-navigate', clearFailure)
    guest.removeListener('render-process-gone', clearFailure)
    guest.removeListener('destroyed', clearFailure)
  }
  guest.on('did-navigate', clearFailure)
  guest.on('render-process-gone', clearFailure)
  guest.on('destroyed', clearFailure)
  await settleBeforeDeadline(
    async () => {
      if (isCurrentDocument() && !guest.isDestroyed()) {
        await guest.debugger.sendCommand('Runtime.terminateExecution')
      }
      clearFailure()
    },
    undefined,
    Date.now() + BROWSER_EVALUATION_CANCEL_TIMEOUT_MS,
    failure
  )
}

export async function runBrowserPageEvaluation<T>(
  guest: WebContents,
  signal: AbortSignal,
  run: () => Promise<T>
): Promise<T> {
  signal.throwIfAborted()
  assertBrowserPageEvaluationAvailable(guest)
  const interrupted = Promise.withResolvers<never>()
  // CDP can throw synchronously after abort, before the race attaches its rejection handler.
  void interrupted.promise.catch(() => {})
  let cancellation: Promise<void> | undefined
  let documentChanged = false
  const pageChangedError = new BrowserError(
    'browser_tab_changed',
    'The page changed while evaluating; retry the command.'
  )
  const onAbort = (): void => {
    if (!documentChanged) {
      cancellation = cancelBrowserPageEvaluation(guest, () => !documentChanged)
    }
    interrupted.reject(signal.reason)
  }
  const onDocumentChanged = (): void => {
    documentChanged = true
    interrupted.reject(pageChangedError)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  guest.on('destroyed', onDocumentChanged)
  guest.on('render-process-gone', onDocumentChanged)
  guest.on('did-navigate', onDocumentChanged)
  try {
    return await Promise.race([run(), interrupted.promise])
  } catch (error) {
    if (error instanceof Error && error.message === 'Inspected target navigated or closed') {
      throw pageChangedError
    }
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
    try {
      // Termination must finish before the queue can dispatch another command on this guest.
      await cancellation
    } finally {
      guest.removeListener('destroyed', onDocumentChanged)
      guest.removeListener('render-process-gone', onDocumentChanged)
      guest.removeListener('did-navigate', onDocumentChanged)
    }
  }
}
