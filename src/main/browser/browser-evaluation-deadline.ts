import { BrowserError } from './cdp-bridge'
import { captureRemoteCliBrowserAbortSignal } from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import { DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE } from '../../shared/desktop-browser-bridge-protocol'

export const BROWSER_EVALUATION_TIMEOUT_MS = 30_000

export function createBrowserEvaluationDeadline(signal?: AbortSignal): {
  signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const revoked = captureRemoteCliBrowserAbortSignal()
  const onCancelled = (): void =>
    controller.abort(new BrowserError('browser_cancelled', 'The browser evaluation request ended.'))
  const onRevoked = (): void =>
    controller.abort(
      new BrowserError(
        DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
        'The Orca desktop stopped sharing its browser while this command ran.'
      )
    )
  const timer = setTimeout(
    () =>
      controller.abort(
        new BrowserError(
          'browser_timeout',
          'The page script did not finish within 30s, including queue time.'
        )
      ),
    BROWSER_EVALUATION_TIMEOUT_MS
  )
  timer.unref?.()
  signal?.addEventListener('abort', onCancelled, { once: true })
  revoked?.addEventListener('abort', onRevoked, { once: true })
  if (revoked?.aborted) {
    onRevoked()
  } else if (signal?.aborted) {
    onCancelled()
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onCancelled)
      revoked?.removeEventListener('abort', onRevoked)
    }
  }
}
