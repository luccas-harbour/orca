// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../store/types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { useAppStore } from '../store'
import {
  acquireBrowserAutomationVisibility,
  releaseBrowserAutomationVisibility
} from './browser-pane/host-guest/browser-automation-visibility'
import { useTerminalBrowserRetention } from './use-terminal-browser-retention'

type RetentionState = Pick<
  AppState,
  'agentStatusByPaneKey' | 'tabsByWorktree' | 'browserTabsByWorktree' | 'browserPagesByWorkspace'
>

const mocks = vi.hoisted(() => ({ destroyGuests: vi.fn() }))

vi.mock('../store', async () => {
  const { createStore } = await import('zustand/vanilla')
  return {
    useAppStore: createStore<RetentionState>(() => ({
      agentStatusByPaneKey: {},
      tabsByWorktree: {},
      browserTabsByWorktree: {},
      browserPagesByWorkspace: {}
    }))
  }
})
vi.mock('../store/slices/browser-webview-cleanup', () => ({
  destroyWorktreeBrowserGuests: mocks.destroyGuests
}))
vi.mock('./browser-pane/host-guest/webview-registry', () => ({
  hasLiveBrowserGuest: () => true
}))
vi.mock('./browser-pane/navigate/browser-page-download-activity', () => ({
  hasActiveBrowserPageDownload: () => false,
  installBrowserPageDownloadActivityTracking: () => () => {}
}))

const worktreeIds = Array.from({ length: 10 }, (_, index) => `wt-${index}`)
const workspaceSurfaceIdSet = new Set(worktreeIds)
const leaseTokens: string[] = []

function agent(worktreeId: string, state: AgentStatusEntry['state'] = 'working'): AgentStatusEntry {
  return {
    paneKey: `${worktreeId}:00000000-0000-4000-8000-000000000000`,
    worktreeId,
    state,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: []
  }
}

function mountRetention(): void {
  renderHook(() => {
    const [revision, setRevision] = useState(0)
    useTerminalBrowserRetention({
      browserGuestRetentionBudgetEnabled: true,
      browserGuestRetentionRevision: revision,
      browserGuestWorktreeRecencyRef: { current: [...worktreeIds] },
      mountedWorktreeIdsRef: { current: workspaceSurfaceIdSet },
      renderedActiveWorktreeId: 'wt-0',
      setBrowserGuestRetentionRevision: setRevision,
      workspaceSurfaceIds: worktreeIds,
      workspaceSurfaceIdSet
    })
  })
}

function expectRetained(worktreeId: string): void {
  expect(mocks.destroyGuests.mock.calls.map((call) => call[2])).not.toContain(worktreeId)
}

describe('browser guest retention during agent work', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T20:00:00Z'))
    mocks.destroyGuests.mockClear()
    useAppStore.setState({
      agentStatusByPaneKey: {},
      tabsByWorktree: {},
      browserPagesByWorkspace: {},
      browserTabsByWorktree: Object.fromEntries(
        worktreeIds.map((worktreeId) => [
          worktreeId,
          [
            {
              id: worktreeId,
              worktreeId,
              sessionProfileId: null,
              url: 'about:blank',
              title: '',
              loading: false,
              faviconUrl: null,
              canGoBack: false,
              canGoForward: false,
              loadError: null,
              createdAt: 1
            }
          ]
        ])
      )
    })
  })

  afterEach(() => {
    act(() => useAppStore.setState({ agentStatusByPaneKey: {}, browserTabsByWorktree: {} }))
    cleanup()
    for (const token of leaseTokens.splice(0)) {
      releaseBrowserAutomationVisibility(token)
    }
    vi.useRealTimers()
  })

  it.each(['working', 'blocked', 'waiting'] as const)(
    'preserves a %s agent page when its ten-second paint lease expires',
    (state) => {
      useAppStore.setState({ agentStatusByPaneKey: { owner: agent('wt-9', state) } })
      const token = acquireBrowserAutomationVisibility('wt-9')
      leaseTokens.push(token)
      window.setTimeout(() => releaseBrowserAutomationVisibility(token), 10_000)
      mountRetention()

      act(() => vi.advanceTimersByTime(10_001))

      expectRetained('wt-9')
      expect(mocks.destroyGuests.mock.calls.map((call) => call[2])).toContain('wt-8')
    }
  )

  it('preserves all nine hidden agent workspaces beyond the ordinary four-workspace budget', () => {
    useAppStore.setState({
      agentStatusByPaneKey: Object.fromEntries(worktreeIds.map((id) => [id, agent(id)]))
    })
    mountRetention()
    act(() => vi.advanceTimersByTime(60_000))
    expect(mocks.destroyGuests).not.toHaveBeenCalled()
  })

  it('preserves completed pages for review and follow-up turns', () => {
    useAppStore.setState({
      agentStatusByPaneKey: { first: agent('wt-8'), second: agent('wt-9') }
    })
    mountRetention()
    mocks.destroyGuests.mockClear()

    act(() => {
      useAppStore.setState({
        agentStatusByPaneKey: { first: agent('wt-8', 'done'), second: agent('wt-9') }
      })
    })

    expectRetained('wt-8')
    expectRetained('wt-9')
  })

  it('does not rerun eviction for status updates that preserve workspace ownership', () => {
    useAppStore.setState({ agentStatusByPaneKey: { owner: agent('wt-9') } })
    mountRetention()
    mocks.destroyGuests.mockClear()
    act(() => {
      useAppStore.setState({
        agentStatusByPaneKey: { owner: { ...agent('wt-9'), prompt: 'next browser command' } }
      })
    })
    expect(mocks.destroyGuests).not.toHaveBeenCalled()
  })

  it.each(['working', 'done'] as const)(
    'preserves an open %s agent page after its retention controller remounts',
    (state) => {
      useAppStore.setState({ agentStatusByPaneKey: { owner: agent('wt-9') } })
      mountRetention()
      act(() => {
        useAppStore.setState({ agentStatusByPaneKey: { owner: agent('wt-9', state) } })
      })
      expectRetained('wt-9')

      cleanup()
      mocks.destroyGuests.mockClear()
      mountRetention()

      expectRetained('wt-9')
      expect(mocks.destroyGuests.mock.calls.map((call) => call[2])).toContain('wt-8')
    }
  )

  it('preserves browser state through remote owner loss and a subsequent completed turn', () => {
    useAppStore.setState({
      agentStatusByPaneKey: { owner: { ...agent('wt-9'), connectionId: 'ssh-connection' } }
    })
    mountRetention()
    mocks.destroyGuests.mockClear()

    act(() => useAppStore.setState({ agentStatusByPaneKey: {} }))
    expectRetained('wt-9')

    act(() => {
      useAppStore.setState({ agentStatusByPaneKey: { owner: agent('wt-9', 'done') } })
    })
    expectRetained('wt-9')
  })

  it.each(['structured', 'remote'] as const)(
    'preserves a completed %s agent page after its retention controller remounts',
    (kind) => {
      const owner: AgentStatusEntry = {
        ...agent('wt-9'),
        ...(kind === 'remote' ? { connectionId: 'ssh-connection' } : { structuredHostOwned: true })
      }
      useAppStore.setState({
        agentStatusByPaneKey: { owner }
      })
      mountRetention()
      act(() => {
        useAppStore.setState({ agentStatusByPaneKey: { owner: { ...owner, state: 'done' } } })
      })
      cleanup()
      mocks.destroyGuests.mockClear()

      mountRetention()

      expectRetained('wt-9')
      expect(mocks.destroyGuests.mock.calls.map((call) => call[2])).toContain('wt-8')
    }
  )

  it('does not retain newly opened pages for an already completed agent', () => {
    const browserTabsByWorktree = useAppStore.getState().browserTabsByWorktree
    useAppStore.setState({
      agentStatusByPaneKey: { owner: agent('wt-9', 'done') },
      browserTabsByWorktree: { ...browserTabsByWorktree, 'wt-9': [] }
    })
    mountRetention()
    mocks.destroyGuests.mockClear()

    act(() => {
      useAppStore.setState({ browserTabsByWorktree })
      const token = acquireBrowserAutomationVisibility('wt-1')
      releaseBrowserAutomationVisibility(token)
    })

    expect(mocks.destroyGuests.mock.calls.map((call) => call[2])).toContain('wt-9')
  })

  it('keeps manual pages evictable after its retention controller remounts', () => {
    const browserTabsByWorktree = useAppStore.getState().browserTabsByWorktree
    useAppStore.setState({
      agentStatusByPaneKey: { owner: agent('wt-9', 'done') },
      browserTabsByWorktree: { ...browserTabsByWorktree, 'wt-9': [] }
    })
    mountRetention()
    act(() => useAppStore.setState({ browserTabsByWorktree }))
    cleanup()
    mocks.destroyGuests.mockClear()

    mountRetention()

    expect(mocks.destroyGuests.mock.calls.map((call) => call[2])).toContain('wt-9')
  })

  it('releases completed ownership when only a later manual tab remains', () => {
    useAppStore.setState({ agentStatusByPaneKey: { owner: agent('wt-9') } })
    mountRetention()
    const browserTabsByWorktree = useAppStore.getState().browserTabsByWorktree
    const originalTabs = browserTabsByWorktree['wt-9']
    const manualTabs = originalTabs.map((tab) => ({ ...tab, id: 'later-manual-tab' }))
    act(() => useAppStore.setState({ agentStatusByPaneKey: { owner: agent('wt-9', 'done') } }))
    act(() => {
      useAppStore.setState({
        browserTabsByWorktree: {
          ...browserTabsByWorktree,
          'wt-9': [...originalTabs, ...manualTabs]
        }
      })
    })
    expectRetained('wt-9')
    mocks.destroyGuests.mockClear()

    act(() => {
      useAppStore.setState({
        browserTabsByWorktree: { ...browserTabsByWorktree, 'wt-9': manualTabs }
      })
    })

    expect(mocks.destroyGuests.mock.calls.map((call) => call[2])).toContain('wt-9')
  })

  it('preserves a disconnected owner page after its retention controller remounts', () => {
    useAppStore.setState({ agentStatusByPaneKey: { owner: agent('wt-9') } })
    mountRetention()
    act(() => useAppStore.setState({ agentStatusByPaneKey: {} }))
    cleanup()
    mocks.destroyGuests.mockClear()

    mountRetention()

    expectRetained('wt-9')
  })

  it('releases ownership when the last browser tab is replaced while unmounted', () => {
    useAppStore.setState({ agentStatusByPaneKey: { owner: agent('wt-9') } })
    mountRetention()
    act(() => useAppStore.setState({ agentStatusByPaneKey: { owner: agent('wt-9', 'done') } }))
    cleanup()
    const browserTabsByWorktree = useAppStore.getState().browserTabsByWorktree
    useAppStore.setState({ browserTabsByWorktree: { ...browserTabsByWorktree, 'wt-9': [] } })
    useAppStore.setState({
      browserTabsByWorktree: {
        ...browserTabsByWorktree,
        'wt-9': browserTabsByWorktree['wt-9'].map((tab) => ({ ...tab, id: 'manual-tab' }))
      }
    })
    mocks.destroyGuests.mockClear()

    mountRetention()

    expect(mocks.destroyGuests.mock.calls.map((call) => call[2])).toContain('wt-9')
  })

  it('releases a disappeared owner when its last browser workspace closes', () => {
    useAppStore.setState({ agentStatusByPaneKey: { owner: agent('wt-9') } })
    mountRetention()
    const browserTabsByWorktree = useAppStore.getState().browserTabsByWorktree
    act(() => useAppStore.setState({ agentStatusByPaneKey: {} }))
    act(() => useAppStore.setState({ browserTabsByWorktree: {} }))
    act(() => useAppStore.setState({ browserTabsByWorktree }))
    mocks.destroyGuests.mockClear()

    act(() => {
      const token = acquireBrowserAutomationVisibility('wt-1')
      releaseBrowserAutomationVisibility(token)
    })

    expect(mocks.destroyGuests.mock.calls.map((call) => call[2])).toContain('wt-9')
  })
})
