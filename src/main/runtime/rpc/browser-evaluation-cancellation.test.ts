import './unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import { BROWSER_CORE_METHODS } from './methods/browser-core'
import { RuntimeBrowserCapture } from '../browser/browser-capture'
import type { AgentBrowserBridge } from '../../browser/agent-browser-bridge'

it('passes request cancellation through the browser RPC and runtime into the evaluation queue', async () => {
  const evaluate = vi.fn(async () => ({ result: '42', origin: 'https://example.com' }))
  const capture = new RuntimeBrowserCapture({
    resolveBrowserCommandTarget: vi.fn(async () => ({
      worktreeId: 'folder-workspace',
      browserPageId: 'page-1'
    })),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: browserEval only uses evaluate on this bridge test double.
    requireAgentBrowserBridge: () => ({ evaluate }) as unknown as AgentBrowserBridge
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this explicit-registry dispatcher only invokes browserEval and reads runtime identity.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    browserEval: capture.browserEval.bind(capture)
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_CORE_METHODS })
  const controller = new AbortController()
  const response = await dispatcher.dispatch(
    {
      id: 'evaluate',
      authToken: 'owner',
      method: 'browser.eval',
      params: { expression: '6*7', page: 'page-1' }
    },
    { signal: controller.signal }
  )
  expect(response.ok).toBe(true)
  expect(evaluate).toHaveBeenCalledWith('6*7', 'folder-workspace', 'page-1', controller.signal)
})
