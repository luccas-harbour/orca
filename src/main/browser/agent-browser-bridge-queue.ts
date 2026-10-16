import type { BrowserTabSwitchResult } from '../../shared/runtime-types'
import { BrowserError } from './cdp-bridge'
import { AgentBrowserBridgeShutdown } from './agent-browser-bridge-shutdown'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import type {
  EnqueueTargetedCommandOptions,
  QueuedCommand,
  ResolvedBrowserCommandTarget
} from './agent-browser-bridge-types'
import { captureRemoteCliBrowserRevocation } from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import { assertBrowserPageEvaluationAvailable } from './browser-page-evaluation'

export abstract class AgentBrowserBridgeQueue extends AgentBrowserBridgeShutdown {
  // Why: route tab switch through the command queue so it can't race in-flight commands targeting the old tab.
  async tabSwitch(
    index: number | undefined,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserTabSwitchResult> {
    return this.enqueueCommand(worktreeId, async () => {
      const tabs = this.getRegisteredTabs(worktreeId)
      // Why: queue delay can change the tab list before execution — recompute against live webContents so no vanished index is activated.
      const liveEntries = [...tabs.entries()].filter(([, wcId]) => this.getWebContents(wcId))
      let switchedIndex = index ?? -1
      let resolvedPageId = browserPageId
      if (resolvedPageId) {
        switchedIndex = liveEntries.findIndex(([tabId]) => tabId === resolvedPageId)
      }
      if (switchedIndex < 0 || switchedIndex >= liveEntries.length) {
        const targetLabel =
          resolvedPageId != null ? `Browser page ${resolvedPageId}` : `Tab index ${index}`
        throw new BrowserError(
          'browser_tab_not_found',
          `${targetLabel} out of range (0-${liveEntries.length - 1})`
        )
      }
      const [tabId, wcId] = liveEntries[switchedIndex]
      this.activeWebContentsId = wcId
      // Why: resolveActiveTab prefers the per-worktree map, so update it or later commands keep routing to the old tab.
      const owningWorktreeId = worktreeId ?? this.browserManager.getWorktreeIdForTab(tabId)
      // Why: `tab switch --page` may omit --worktree, so still update the owning worktree's active slot for later scoped commands.
      if (owningWorktreeId) {
        this.activeWebContentsPerWorktree.set(owningWorktreeId, wcId)
      }
      this.options.onTabsChanged?.(owningWorktreeId ?? undefined)
      return { switched: switchedIndex, browserPageId: tabId }
    })
  }
  // ── Internal ──

  protected async enqueueCommand<T>(
    worktreeId: string | undefined,
    execute: (sessionName: string) => Promise<T>
  ): Promise<T> {
    return this.enqueueTargetedCommand(worktreeId, undefined, execute)
  }

  protected async enqueueTargetedCommand<T>(
    worktreeId: string | undefined,
    browserPageId: string | undefined,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions = {}
  ): Promise<T> {
    this.assertCommandAdmission()
    options.signal?.throwIfAborted()
    const assertNotRevoked = captureRemoteCliBrowserRevocation()
    assertNotRevoked()
    const { browserPageId: pageId } = this.resolveCommandTarget(
      worktreeId,
      browserPageId,
      options.requireScopedTarget
    )
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${pageId}`

    return new Promise<T>((resolve, reject) => {
      let queue = this.commandQueues.get(sessionName)
      if (!queue) {
        queue = []
        this.commandQueues.set(sessionName, queue)
      }
      const removeCancellation = (): void => options.signal?.removeEventListener('abort', onAbort)
      const onAbort = (): void => {
        const index = queue.indexOf(command)
        if (index === -1) {
          return
        }
        queue.splice(index, 1)
        command.reject(options.signal?.reason)
      }
      const command: QueuedCommand = {
        execute: () => {
          removeCancellation()
          options.signal?.throwIfAborted()
          assertNotRevoked()
          return this.executeQueuedCommand(
            worktreeId,
            pageId,
            (session, target) => {
              assertNotRevoked(target.webContentsId)
              return execute(session, target)
            },
            options
          )
        },
        resolve: (value) => {
          removeCancellation()
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execute returns the T accepted by this queue entry's resolver.
          resolve(value as T)
        },
        reject: (error) => {
          removeCancellation()
          reject(error)
        }
      }
      queue.push(command)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.processQueue(sessionName)
    })
  }

  protected async executeQueuedCommand<T>(
    worktreeId: string | undefined,
    browserPageId: string,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions
  ): Promise<T> {
    this.assertCommandAdmission()
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${browserPageId}`
    // Why: the page's guest can change while queued; bind to the one current at execution.
    const target = this.resolveCommandTarget(worktreeId, browserPageId)
    const guest = this.getWebContents(target.webContentsId)
    if (guest && !options.allowEvaluationRecovery) {
      assertBrowserPageEvaluationAvailable(guest)
    }
    if (options.ensureSession !== false) {
      await this.ensureSession(sessionName, browserPageId, target.webContentsId)
    }
    return execute(sessionName, target)
  }

  protected async processQueue(sessionName: string): Promise<void> {
    if (this.processingQueues.has(sessionName)) {
      return
    }
    this.processingQueues.add(sessionName)

    const queue = this.commandQueues.get(sessionName)
    while (queue && queue.length > 0) {
      const cmd = queue.shift()!
      try {
        const result = await cmd.execute()
        cmd.resolve(result)
      } catch (error) {
        cmd.reject(error)
      }
    }

    if (this.commandQueues.get(sessionName) === queue) {
      if (queue && queue.length === 0) {
        this.commandQueues.delete(sessionName)
      }
      this.processingQueues.delete(sessionName)
    }
  }
}
