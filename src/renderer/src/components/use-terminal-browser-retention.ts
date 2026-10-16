import { useEffect, useRef } from 'react'
import { shallow } from 'zustand/shallow'
import { useAppStore } from '../store'
import { getWorktreeIdsWithUnfinishedAgent } from '../lib/worktree-activity-state'
import { onBrowserGuestPaintRetentionChange } from './browser-pane/host-guest/browser-guest-paint-retention'
import { browserTabsVetoGuestEviction } from './browser-pane/host-guest/browser-guest-eviction-veto'
import {
  selectBrowserGuestEvictionWorktreeIds,
  touchBrowserGuestWorktreeRecency,
  worktreeHoldsLiveBrowserGuests
} from './browser-pane/host-guest/browser-guest-worktree-retention'
import { installBrowserPageDownloadActivityTracking } from './browser-pane/navigate/browser-page-download-activity'
import { hasLiveBrowserGuest } from './browser-pane/host-guest/webview-registry'
import { destroyWorktreeBrowserGuests } from '../store/slices/browser-webview-cleanup'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'

type BrowserRetentionController = Pick<
  TerminalParkingFoundation,
  | 'browserGuestRetentionBudgetEnabled'
  | 'browserGuestRetentionRevision'
  | 'browserGuestWorktreeRecencyRef'
  | 'mountedWorktreeIdsRef'
  | 'renderedActiveWorktreeId'
  | 'setBrowserGuestRetentionRevision'
  | 'workspaceSurfaceIds'
  | 'workspaceSurfaceIdSet'
>

export function useTerminalBrowserRetention(controller: BrowserRetentionController): void {
  const agentWorktreeIdsRef = useRef<ReadonlySet<string>>(new Set())
  const {
    browserGuestRetentionBudgetEnabled,
    browserGuestRetentionRevision,
    browserGuestWorktreeRecencyRef,
    mountedWorktreeIdsRef,
    renderedActiveWorktreeId,
    setBrowserGuestRetentionRevision,
    workspaceSurfaceIds,
    workspaceSurfaceIdSet
  } = controller

  useEffect(() => {
    const invalidateRetention = (): void => {
      setBrowserGuestRetentionRevision((revision) => revision + 1)
    }
    const removeDownloadTracking = installBrowserPageDownloadActivityTracking(invalidateRetention)
    const removePaintRetentionTracking = onBrowserGuestPaintRetentionChange(invalidateRetention)
    const state = useAppStore.getState()
    agentWorktreeIdsRef.current = getWorktreeIdsWithUnfinishedAgent(
      state.agentStatusByPaneKey,
      state.tabsByWorktree
    )
    const removeAgentTracking = useAppStore.subscribe((state, previous) => {
      if (
        state.agentStatusByPaneKey === previous.agentStatusByPaneKey &&
        state.tabsByWorktree === previous.tabsByWorktree &&
        state.browserTabsByWorktree === previous.browserTabsByWorktree
      ) {
        return
      }
      const next = getWorktreeIdsWithUnfinishedAgent(
        state.agentStatusByPaneKey,
        state.tabsByWorktree
      )
      // Turn completion or lost contact must not discard a page awaiting review or a follow-up.
      for (const id of agentWorktreeIdsRef.current) {
        if ((state.browserTabsByWorktree[id]?.length ?? 0) > 0) {
          next.add(id)
        }
      }
      if (!shallow(agentWorktreeIdsRef.current, next)) {
        agentWorktreeIdsRef.current = next
        invalidateRetention()
      }
    })
    return () => {
      removeDownloadTracking()
      removePaintRetentionTracking()
      removeAgentTracking()
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the controller setter preserves its original stable identity.
  }, [])

  useEffect(() => {
    if (!renderedActiveWorktreeId) {
      return
    }
    const recency = browserGuestWorktreeRecencyRef.current
    touchBrowserGuestWorktreeRecency(recency, renderedActiveWorktreeId)
    for (let index = recency.length - 1; index >= 0; index--) {
      if (!workspaceSurfaceIdSet.has(recency[index])) {
        recency.splice(index, 1)
      }
    }
    if (!browserGuestRetentionBudgetEnabled) {
      return
    }
    const state = useAppStore.getState()
    const recencyIds = new Set(recency)
    const orderedWorktreeIds = [
      ...recency,
      ...workspaceSurfaceIds.filter((id) => !recencyIds.has(id))
    ]
    const evictedWorktreeIds = selectBrowserGuestEvictionWorktreeIds({
      orderedWorktreeIds,
      activeWorktreeId: renderedActiveWorktreeId,
      isRetained: (worktreeId) => mountedWorktreeIdsRef.current.has(worktreeId),
      holdsLiveGuests: (worktreeId) =>
        worktreeHoldsLiveBrowserGuests(
          state.browserTabsByWorktree[worktreeId] ?? [],
          state.browserPagesByWorkspace,
          hasLiveBrowserGuest
        ),
      // Unfinished work owns browser state between commands, after its bootstrap paint lease expires.
      isEvictable: (worktreeId) =>
        !agentWorktreeIdsRef.current.has(worktreeId) &&
        !browserTabsVetoGuestEviction(state.browserTabsByWorktree[worktreeId] ?? [])
    })
    for (const worktreeId of evictedWorktreeIds) {
      destroyWorktreeBrowserGuests(
        state.browserTabsByWorktree,
        state.browserPagesByWorkspace,
        worktreeId
      )
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs preserve their original stable identities.
  }, [
    renderedActiveWorktreeId,
    workspaceSurfaceIds,
    browserGuestRetentionBudgetEnabled,
    browserGuestRetentionRevision
  ])
}
