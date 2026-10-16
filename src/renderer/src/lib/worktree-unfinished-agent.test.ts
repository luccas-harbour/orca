import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { getWorktreeIdsWithUnfinishedAgent } from './worktree-activity-state'

const paneKey = 'terminal:00000000-0000-4000-8000-000000000000'

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey,
    state: 'working',
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    stateHistory: [],
    ...overrides
  }
}

describe('workspaces with unfinished agents', () => {
  it('attributes old hook rows through their terminal tab', () => {
    expect(
      getWorktreeIdsWithUnfinishedAgent(
        { owner: entry() },
        { 'folder:example': [{ id: 'terminal' }] }
      )
    ).toEqual(new Set(['folder:example']))
  })

  it('preserves a remote owner despite stale evidence and colliding local tab IDs', () => {
    expect(
      getWorktreeIdsWithUnfinishedAgent(
        { owner: entry({ worktreeId: 'remote-workspace', connectionId: 'ssh-connection' }) },
        { 'local-workspace': [{ id: 'terminal' }] }
      )
    ).toEqual(new Set(['remote-workspace']))
  })

  it('attributes structured agents without a terminal', () => {
    expect(
      getWorktreeIdsWithUnfinishedAgent(
        { owner: entry({ worktreeId: 'folder:example', structuredHostOwned: true }) },
        {}
      )
    ).toEqual(new Set(['folder:example']))
  })

  it('keeps an unconfirmed owner until the execution host establishes completion', () => {
    expect(
      getWorktreeIdsWithUnfinishedAgent(
        { owner: entry({ worktreeId: 'remote-workspace', restoredUnconfirmed: true }) },
        {}
      )
    ).toEqual(new Set(['remote-workspace']))
    expect(
      getWorktreeIdsWithUnfinishedAgent(
        { owner: entry({ worktreeId: 'remote-workspace', state: 'done' }) },
        {}
      )
    ).toEqual(new Set())
  })

  it('does not protect unrelated workspaces for an unattributed row', () => {
    expect(getWorktreeIdsWithUnfinishedAgent({ owner: entry() }, {})).toEqual(new Set())
  })
})
