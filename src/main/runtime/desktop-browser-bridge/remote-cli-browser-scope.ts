/**
 * The workspace a forwarded SSH-host command may touch on this desktop. While a bridged command
 * runs, every workspace selector the browser layer resolves must name exactly that workspace; any
 * other selector is refused, so a host can never widen its reach to the desktop's own worktrees.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { BrowserError } from '../../browser/browser-error'
import {
  DESKTOP_BROWSER_BRIDGE_SCOPE_CODE,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
  DESKTOP_BROWSER_BRIDGE_UNROUTED_CODE
} from '../../../shared/desktop-browser-bridge-protocol'

type RemoteCliBrowserScope = {
  workspaceId: string
  revoked?: AbortSignal
  /** True only for a guest that browses through this host's SSH route right now. */
  admitGuest?: (webContentsId: number) => boolean
}

const scope = new AsyncLocalStorage<RemoteCliBrowserScope>()

export function runInRemoteCliBrowserScope<T>(
  workspaceId: string,
  run: () => Promise<T>,
  revoked?: AbortSignal,
  admitGuest?: (webContentsId: number) => boolean
): Promise<T> {
  return scope.run(
    { workspaceId, ...(revoked ? { revoked } : {}), ...(admitGuest ? { admitGuest } : {}) },
    run
  )
}

/**
 * Captured where a browser command is queued; the returned check throws once the bridge that
 * issued it detached, so a command waiting behind another never runs after access was revoked.
 */
export function captureRemoteCliBrowserRevocation(): (webContentsId?: number) => void {
  const active = scope.getStore()
  return (webContentsId) => {
    if (active?.revoked?.aborted) {
      throw new BrowserError(
        DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
        'The Orca desktop stopped sharing its browser before this command ran.'
      )
    }
    // Why at execution: routing can be turned off while the command waits, remounting the page unrouted.
    if (webContentsId !== undefined && active?.admitGuest && !active.admitGuest(webContentsId)) {
      throw new BrowserError(
        DESKTOP_BROWSER_BRIDGE_UNROUTED_CODE,
        "This page is not browsing through the SSH host, so the host's orca CLI cannot use it."
      )
    }
  }
}

/** Null outside a bridged command; inside one, the scoped workspace or a refusal. */
export function resolveRemoteCliBrowserScopeSelector(
  selector: string
): Promise<{ id: string }> | null {
  const active = scope.getStore()
  if (!active) {
    return null
  }
  if (selector === `id:${active.workspaceId}`) {
    return Promise.resolve({ id: active.workspaceId })
  }
  return Promise.reject(
    new BrowserError(
      DESKTOP_BROWSER_BRIDGE_SCOPE_CODE,
      'An SSH host can only reach browser tabs in its own workspaces.'
    )
  )
}

export function captureRemoteCliBrowserAbortSignal(): AbortSignal | undefined {
  return scope.getStore()?.revoked
}
