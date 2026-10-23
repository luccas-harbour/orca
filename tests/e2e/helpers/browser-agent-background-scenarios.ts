import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { startProbeServer } from './browser-agent-input-probe-server'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  switchToOtherWorktree,
  waitForActiveWorktree
} from './store'
import {
  evalInPage,
  focusTerminalAndWatchHost,
  readHost,
  rpc
} from './browser-agent-focus-scenarios'

type UserTerminal = { worktreeId: string; tabId: string }

async function openProbe(page: Page, url: string): Promise<string> {
  const pageId = await page.evaluate((targetUrl) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Missing probe workspace')
    }
    return state.createBrowserTab(state.activeWorktreeId, targetUrl, {
      title: 'Inactive agent page',
      activate: true
    })?.activePageId
  }, url)
  if (!pageId) {
    throw new Error('Probe page was not created')
  }
  await prepareProbe(page, pageId)
  return pageId
}

async function prepareProbe(page: Page, pageId: string): Promise<void> {
  await expect(async () => {
    expect(
      await evalInPage(
        page,
        pageId,
        `document.readyState === 'complete' && innerWidth > 0 && innerHeight > 120 && typeof window.__clicks`
      )
    ).toBe('number')
  }).toPass({ timeout: 20_000 })
  await evalInPage(
    page,
    pageId,
    `(() => {
      document.body.dataset.backgroundProbe = 'original-document';
      document.body.dataset.trustedKeys = '[]';
      document.addEventListener('keydown', event => {
        const keys = JSON.parse(document.body.dataset.trustedKeys);
        keys.push({ key: event.key, trusted: event.isTrusted, target: event.target.id });
        document.body.dataset.trustedKeys = JSON.stringify(keys);
      }, true);
      document.getElementById('probe').focus();
    })()`
  )
}

async function returnToUserTerminal(page: Page, otherWorkspace: boolean): Promise<UserTerminal> {
  if (otherWorkspace) {
    const current = await getActiveWorktreeId(page)
    const target = current && (await switchToOtherWorktree(page, current))
    if (!target) {
      throw new Error('The fixture needs its seeded second worktree')
    }
    await expect.poll(() => getActiveWorktreeId(page)).toBe(target)
  }
  await ensureTerminalVisible(page)
  const worktreeId = await getActiveWorktreeId(page)
  const tabId = await getActiveTabId(page)
  if (!worktreeId || !tabId) {
    throw new Error('Missing user terminal')
  }
  await expect(
    page.locator(`[data-terminal-tab-id="${tabId}"] .xterm-helper-textarea`)
  ).toHaveCount(1)
  await focusTerminalAndWatchHost(page, tabId)
  const user = { worktreeId, tabId }
  await expectUserTerminal(page, user)
  return user
}

async function expectUserTerminal(page: Page, user: UserTerminal): Promise<void> {
  await expect(
    page.locator(`[data-terminal-tab-id="${user.tabId}"] .xterm-helper-textarea:focus`)
  ).toHaveCount(1)
  expect(await getActiveWorktreeId(page)).toBe(user.worktreeId)
  expect(await getActiveTabId(page)).toBe(user.tabId)
}

async function openUnselectedProbe(page: Page, url: string, user: UserTerminal): Promise<string> {
  const created = await rpc(page, 'browser.tabCreate', {
    url,
    worktree: `id:${user.worktreeId}`,
    activate: false
  })
  if (
    !created ||
    typeof created !== 'object' ||
    !('browserPageId' in created) ||
    typeof created.browserPageId !== 'string'
  ) {
    throw new Error('Missing newly created page ID')
  }
  await prepareProbe(page, created.browserPageId)
  await expectUserTerminal(page, user)
  return created.browserPageId
}

export async function runAgentInactivePagesScenario(
  page: Page,
  otherWorkspace: boolean
): Promise<void> {
  const server = await startProbeServer()
  try {
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    const worktreeId = await getActiveWorktreeId(page)
    if (!worktreeId) {
      throw new Error('Missing agent workspace')
    }
    const first = await openProbe(page, server.url)
    const second = await openProbe(page, server.url)
    const user = await returnToUserTerminal(page, otherWorkspace)
    // Outlast the ten-second bootstrap paint lease without renewing it through a command.
    await page.waitForTimeout(11_000)

    for (const [index, pageId] of [first, second, first, second].entries()) {
      await rpc(page, 'browser.tabSwitch', {
        page: pageId,
        worktree: `id:${worktreeId}`,
        focus: false
      })
      await expectUserTerminal(page, user)
      expect(await evalInPage(page, pageId, 'document.body.dataset.backgroundProbe')).toBe(
        'original-document'
      )
      await evalInPage(
        page,
        pageId,
        `(() => {
          const field = document.getElementById('probe');
          field.value = '';
          field.focus();
          field.setSelectionRange(0, 0);
          document.body.dataset.trustedKeys = '[]';
        })()`
      )
      await rpc(page, 'browser.keypress', { page: pageId, key: 'Control+Home' })
      await rpc(page, 'browser.keypress', { page: pageId, key: 'Shift' })
      await rpc(page, 'browser.type', { page: pageId, input: `agent-${index}` })

      await expect
        .poll(() =>
          evalInPage(
            page,
            pageId,
            `JSON.stringify({
              document: document.body.dataset.backgroundProbe,
              keys: JSON.parse(document.body.dataset.trustedKeys),
              text: document.getElementById('probe').value
            })`
          )
        )
        .toBe(
          JSON.stringify({
            document: 'original-document',
            keys: [
              { key: 'Home', trusted: true, target: 'probe' },
              { key: 'Shift', trusted: true, target: 'probe' }
            ],
            text: `agent-${index}`
          })
        )
      await expectUserTerminal(page, user)
      expect((await readHost(page)).log).toEqual([])
    }
  } finally {
    await server.close()
  }
}

export async function runAgentDelayedGuardScenario(page: Page): Promise<void> {
  const server = await startProbeServer()
  try {
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    const pageId = await openProbe(page, server.url)
    const user = await returnToUserTerminal(page, false)

    const result = await page.evaluate(async (targetPage) => {
      const guards: { active: boolean; elapsedMs: number }[] = []
      const started = performance.now()
      const unsubscribe = window.api.browser.onAgentInputFocusGuard(({ active }) => {
        guards.push({ active, elapsedMs: performance.now() - started })
      })
      const pending = window.api.runtime.call({
        method: 'browser.mouseClick',
        params: { page: targetPage, x: 100, y: 100, button: 'left' }
      })
      // Keep only this isolated renderer busy while main requests its focus guard.
      const until = performance.now() + 400
      while (performance.now() < until) {
        // Deliberately hold the renderer's IPC acknowledgement, not the guest's event loop.
      }
      try {
        const response: unknown = await pending
        await new Promise((resolve) => setTimeout(resolve, 0))
        return { response, guards, elapsedMs: performance.now() - started }
      } finally {
        unsubscribe()
      }
    }, pageId)

    expect(
      result.response,
      `A recovered host renderer must allow background input to finish: ${JSON.stringify(result)}`
    ).toMatchObject({
      ok: true
    })
    await expect.poll(() => evalInPage(page, pageId, 'window.__clicks')).toBe('1')
    await expectUserTerminal(page, user)
    expect((await readHost(page)).log.filter((entry) => entry.startsWith('key:'))).toEqual([])
  } finally {
    await server.close()
  }
}

export async function runAgentUnselectedPageScenario(page: Page): Promise<void> {
  const server = await startProbeServer()
  try {
    await waitForActiveWorktree(page)
    const user = await returnToUserTerminal(page, false)
    const pageId = await openUnselectedProbe(page, server.url, user)
    await rpc(page, 'browser.keypress', { page: pageId, key: 'Shift' })
    await rpc(page, 'browser.type', { page: pageId, input: 'never-selected' })
    await expect
      .poll(() =>
        evalInPage(
          page,
          pageId,
          `JSON.stringify({ keys: JSON.parse(document.body.dataset.trustedKeys), text: document.getElementById('probe').value })`
        )
      )
      .toBe(
        JSON.stringify({
          keys: [{ key: 'Shift', trusted: true, target: 'probe' }],
          text: 'never-selected'
        })
      )
    await expectUserTerminal(page, user)
    expect((await readHost(page)).log).toEqual([])
  } finally {
    await server.close()
  }
}

export async function runAgentBackgroundWorkerScenario(page: Page): Promise<void> {
  const server = await startProbeServer()
  try {
    await waitForActiveWorktree(page)
    const user = await returnToUserTerminal(page, false)
    const pageId = await openUnselectedProbe(page, server.url, user)
    const result = await evalInPage(
      page,
      pageId,
      `(async () => {
        const source = new Blob(['postMessage("hello"); onmessage = event => postMessage(event.data)'], { type: 'text/javascript' });
        const url = URL.createObjectURL(source);
        const worker = new Worker(url);
        let timer;
        try {
          return await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Background worker never sent hello')), 5000);
            worker.onerror = event => reject(new Error(event.message));
            worker.onmessage = event => {
              if (event.data === 'hello') worker.postMessage('reply');
              else resolve(event.data);
            };
          });
        } finally {
          clearTimeout(timer);
          worker.terminate();
          URL.revokeObjectURL(url);
        }
      })()`
    )
    expect(result).toBe('reply')
    await expectUserTerminal(page, user)
    expect((await readHost(page)).log).toEqual([])
  } finally {
    await server.close()
  }
}
