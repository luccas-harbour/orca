import { randomUUID } from 'node:crypto'
import { ipcMain, type WebContents } from 'electron'
import { BrowserError } from './browser-error'

// Why: any press on a <webview> guest moves Chromium focus into it, whatever path dispatches it,
// and input that only CDP can express needs the guest focused. Only the pane hosting the guest
// can put the user's focus back afterwards (#20595).
// See docs/reference/agent-browser-focus-isolation.md.

/** Resolves once the hosting pane holds the user's focus; call the result when the input ends. */
export type AgentInputFocusGuard = () => Promise<() => void>

export const AGENT_INPUT_FOCUS_GUARD_CHANNEL = 'browser:agentInputFocusGuard'
export const AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL = 'browser:agentInputFocusGuardReady'

// Short host stalls must not require revealing the agent's page to send guarded input.
const PANE_READY_TIMEOUT_MS = 1_000

export function focusGuardUnavailableError(): BrowserError {
  return new BrowserError(
    'browser_focus_guard_unavailable',
    "Orca could not protect the user's keyboard focus for this page, so the input was not sent. Retry when its hosting pane is responsive."
  )
}

export async function guardPaneFocusForAgentInput(
  renderer: WebContents,
  browserPageId: string
): Promise<() => void> {
  const token = randomUUID()
  const answered = await new Promise<boolean>((resolve) => {
    const finish = (ready: boolean): void => {
      clearTimeout(timer)
      ipcMain.removeListener(AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL, onReady)
      resolve(ready)
    }
    const onReady = (event: Electron.IpcMainEvent, reply: unknown): void => {
      if (
        event.sender.id === renderer.id &&
        reply !== null &&
        typeof reply === 'object' &&
        'token' in reply &&
        reply.token === token
      ) {
        finish(true)
      }
    }
    const timer = setTimeout(() => finish(false), PANE_READY_TIMEOUT_MS)
    ipcMain.on(AGENT_INPUT_FOCUS_GUARD_READY_CHANNEL, onReady)
    renderer.send(AGENT_INPUT_FOCUS_GUARD_CHANNEL, { browserPageId, token, active: true })
  })
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    if (!renderer.isDestroyed()) {
      renderer.send(AGENT_INPUT_FOCUS_GUARD_CHANNEL, { browserPageId, token, active: false })
    }
  }
  if (!answered) {
    // Why: input sent without a pane holding the user's element would take their focus for good.
    release()
    throw focusGuardUnavailableError()
  }
  return release
}

/** CDP input that makes Chromium focus the guest (measured: mouse, touch and tap presses). */
export function isFocusTakingCdpInput(method: string, params: Record<string, unknown>): boolean {
  switch (method) {
    case 'Input.dispatchMouseEvent':
    case 'Input.emulateTouchFromMouseEvent':
      return params.type === 'mousePressed'
    case 'Input.dispatchTouchEvent':
      return params.type === 'touchStart'
    case 'Input.synthesizeTapGesture':
      return true
    default:
      return false
  }
}

// Why: Chromium routes IME composition on a guest's root session by window focus, like key input.
export function isFocusRoutedCdpInput(method: string): boolean {
  return method === 'Input.imeSetComposition'
}

/** Makes the page treat itself as focused while Orca's window keeps the user's real focus. */
export function enablePageFocusEmulation(
  send: (method: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<void> {
  // Why: when the user's focus comes back the page would see blur and close the menu or picker
  // the agent just opened. Best effort: a page without it only loses that nicety.
  return send('Emulation.setFocusEmulationEnabled', { enabled: true }).then(
    () => undefined,
    () => undefined
  )
}
