import { useEffect } from 'react'
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

// Remember observed ownership across controller remounts without claiming later manual pages.
const agentBrowserTabIdsByWorktree = new Map<string, ReadonlySet<string>>()

function updateAgentBrowserRetention(state: ReturnType<typeof useAppStore.getState>): boolean {
  const unfinished = getWorktreeIdsWithUnfinishedAgent(
    state.agentStatusByPaneKey,
    state.tabsByWorktree
  )
  const next = new Map<string, ReadonlySet<string>>()
  for (const id of new Set([...unfinished, ...agentBrowserTabIdsByWorktree.keys()])) {
    const previous = agentBrowserTabIdsByWorktree.get(id)
    const tabIds = new Set(
      (state.browserTabsByWorktree[id] ?? [])
        .filter((tab) => unfinished.has(id) || previous?.has(tab.id))
        .map((tab) => tab.id)
    )
    if (unfinished.has(id) || tabIds.size > 0) {
      next.set(id, tabIds)
    }
  }
  const changed = !shallow(new Set(agentBrowserTabIdsByWorktree.keys()), new Set(next.keys()))
  agentBrowserTabIdsByWorktree.clear()
  for (const [id, tabIds] of next) {
    agentBrowserTabIdsByWorktree.set(id, tabIds)
  }
  return changed
}

export function useTerminalBrowserRetention(controller: BrowserRetentionController): void {
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
    updateAgentBrowserRetention(useAppStore.getState())
    const removeAgentTracking = useAppStore.subscribe((state, previous) => {
      if (
        state.agentStatusByPaneKey === previous.agentStatusByPaneKey &&
        state.tabsByWorktree === previous.tabsByWorktree &&
        state.browserTabsByWorktree === previous.browserTabsByWorktree
      ) {
        return
      }
      if (updateAgentBrowserRetention(state)) {
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
      // Agent-owned pages survive completed turns and bootstrap paint lease expiry.
      isEvictable: (worktreeId) =>
        !agentBrowserTabIdsByWorktree.has(worktreeId) &&
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
