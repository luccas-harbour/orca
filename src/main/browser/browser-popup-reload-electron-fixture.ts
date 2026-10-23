import type { WebContents } from 'electron'
import { AgentBrowserBridge } from './agent-browser-bridge'
import type { BrowserManager } from './browser-manager'

export function createPopupFixtureReloadController(
  manager: BrowserManager,
  writeStatus: () => void
): {
  receipts: Record<string, { completed: number; error?: string }>
  attach: (guest: WebContents, pageId: string) => void
} {
  const bridge =
    process.env.ORCA_POPUP_FIXTURE_BROWSER_RELOAD === '1' ? new AgentBrowserBridge(manager) : null
  const receipts: Record<string, { completed: number; error?: string }> = {}
  return {
    receipts,
    attach(guest, pageId) {
      if (!bridge) {
        return
      }
      guest.on('console-message', ({ message }) => {
        if (message !== 'orca-popup-fixture:reload') {
          return
        }
        const receipt = (receipts[pageId] ??= { completed: 0 })
        void bridge.reload(undefined, pageId).then(
          () => {
            receipt.completed += 1
            writeStatus()
          },
          (error: unknown) => {
            receipt.error = String(error)
            writeStatus()
          }
        )
      })
    }
  }
}
