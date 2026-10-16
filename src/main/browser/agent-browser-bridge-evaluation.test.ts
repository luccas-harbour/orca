import { describe, it, expect, vi, afterEach } from 'vitest'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock } = vi.hoisted(
  () => ({
    execFileMock: vi.fn(),
    webContentsFromIdMock: vi.fn(),
    existsSyncMock: vi.fn(() => false),
    readFileSyncMock: vi.fn(() => Buffer.from(''))
  })
)

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  accessSync: vi.fn(),
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))
vi.mock('os', () => ({ platform: () => 'darwin', arch: () => 'arm64' }))
vi.mock('electron', () => {
  return {
    app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
    webContents: { fromId: webContentsFromIdMock }
  }
})
const { CdpWsProxyMock } = vi.hoisted(() => {
  const instances: unknown[] = []
  const MockClass = vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    _wc: unknown
  ) {
    this._wc = _wc
    this.start = vi.fn(async () => 'ws://127.0.0.1:9222')
    this.stop = vi.fn(async () => {})
    this.getPort = vi.fn(() => 9222)
    instances.push(this)
  })
  return { CdpWsProxyMock: Object.assign(MockClass, { instances }) }
})

vi.mock('./cdp-ws-proxy', () => ({
  CdpWsProxy: CdpWsProxyMock
}))
vi.mock('./cdp-bridge', () => ({
  BrowserError: class BrowserError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
}))

import { AgentBrowserBridge } from './agent-browser-bridge'
import { EventEmitter } from 'node:events'
import { runInRemoteCliBrowserScope } from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import {
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

function evaluationFixture() {
  const first = mockWebContents(100)
  const second = mockWebContents(200)
  first.debugger.sendCommand.mockImplementation(async (method) => {
    if (method === 'Runtime.evaluate') {
      return await new Promise(() => {})
    }
    return {}
  })
  second.debugger.sendCommand.mockResolvedValue({})
  webContentsFromIdMock.mockImplementation((id) => (id === 100 ? first : second))
  const tabs = new Map([
    ['tab-1', 100],
    ['tab-2', 200]
  ])
  const bridge = new AgentBrowserBridge(mockBrowserManager(tabs))
  bridge.setActiveTab(100)
  return { bridge, first, second, tabs }
}

function captureGuestLifecycle(first: ReturnType<typeof mockWebContents>): EventEmitter {
  const events = new EventEmitter()
  first.on.mockImplementation((event, listener) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are Electron event listeners emitted with their declared arguments below.
    events.on(event, listener as Parameters<typeof events.on>[1])
  })
  first.removeListener.mockImplementation((event, listener) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: removes the same Electron listener installed above.
    events.removeListener(event, listener as Parameters<typeof events.removeListener>[1])
  })
  return events
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('browser evaluation cancellation', () => {
  it('reports CDP context replacement even when its error precedes the navigation event', async () => {
    const { bridge, first } = evaluationFixture()
    first.debugger.sendCommand.mockRejectedValueOnce(
      new Error('Inspected target navigated or closed')
    )
    await expect(bridge.evaluate('pending', undefined, 'tab-1')).rejects.toMatchObject({
      code: 'browser_tab_changed'
    })
    first.debugger.sendCommand.mockResolvedValue({ result: { value: 42 } })
    await expect(bridge.evaluate('6*7', undefined, 'tab-1')).resolves.toMatchObject({
      result: '42'
    })
  })

  it('keeps an evaluation active when a navigation starts without committing', async () => {
    vi.useFakeTimers()
    const { bridge, first } = evaluationFixture()
    const events = captureGuestLifecycle(first)
    let failure: unknown
    const evaluation = bridge.evaluate('pending', undefined, 'tab-1').catch((error) => {
      failure = error
    })
    events.emit('did-start-navigation', {}, 'https://download.example', false, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(failure).toBeUndefined()
    await vi.advanceTimersByTimeAsync(30_000)
    await evaluation
    expect(failure).toMatchObject({ code: 'browser_timeout' })
    expect(first.debugger.sendCommand).toHaveBeenCalledWith('Runtime.terminateExecution')
    expect(events.eventNames()).toEqual([])
  })

  it('reports an unavailable page when the guest is destroyed during evaluation', async () => {
    const { bridge, first } = evaluationFixture()
    const events = captureGuestLifecycle(first)
    const evaluation = bridge.evaluate('pending', undefined, 'tab-1')
    const rejected = expect(evaluation).rejects.toMatchObject({ code: 'browser_tab_not_found' })
    first.isDestroyed = () => true
    events.emit('destroyed')
    await rejected
    expect(events.eventNames()).toEqual([])
  })

  it.each(['goto', 'reload'])(
    'recovers through %s after detach rejects a stalled termination',
    async (recovery) => {
      vi.useFakeTimers()
      const { bridge, first } = evaluationFixture()
      const events = captureGuestLifecycle(first)
      const cancelled = Promise.withResolvers<unknown>()
      let attached = false
      first.debugger.isAttached.mockImplementation(() => attached)
      first.debugger.attach.mockImplementation(() => {
        attached = true
      })
      first.debugger.detach.mockImplementation(() => {
        attached = false
        cancelled.reject(new Error('Debugger detached'))
      })
      first.debugger.sendCommand.mockImplementation((method) =>
        method === 'Runtime.terminateExecution' ? cancelled.promise : new Promise(() => {})
      )
      const evaluation = bridge.evaluate('pending', undefined, 'tab-1').catch((error) => error)
      await vi.advanceTimersByTimeAsync(31_000)
      await expect(evaluation).resolves.toMatchObject({ code: 'browser_error' })
      expect(first.debugger.detach).toHaveBeenCalledOnce()
      await expect(bridge.mouseMove(10, 20, undefined, 'tab-1')).rejects.toMatchObject({
        code: 'browser_error'
      })
      first.loadURL.mockImplementation(async () => {
        events.emit('did-navigate', {}, 'https://recovered.example')
      })
      Object.assign(first, {
        reload: () => {
          setTimeout(() => {
            events.emit('did-navigate', {}, 'https://recovered.example')
            events.emit('did-finish-load')
          }, 0)
        }
      })
      const navigation =
        recovery === 'goto'
          ? bridge.goto('https://recovered.example', undefined, 'tab-1')
          : bridge.reload(undefined, 'tab-1')
      await vi.advanceTimersByTimeAsync(0)
      await expect(navigation).resolves.toBeDefined()
      first.debugger.sendCommand.mockResolvedValue({ result: { value: 42 } })
      await expect(bridge.evaluate('6*7', undefined, 'tab-1')).resolves.toMatchObject({
        result: '42'
      })
      expect(events.eventNames()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('handles a synchronous debugger failure racing request cancellation without an unhandled rejection', async () => {
    const { bridge, first } = evaluationFixture()
    const controller = new AbortController()
    first.debugger.sendCommand.mockImplementation((method) => {
      if (method === 'Runtime.evaluate') {
        controller.abort()
        throw new Error('Debugger detached')
      }
      return Promise.resolve({})
    })
    await expect(
      bridge.evaluate('pending', undefined, 'tab-1', controller.signal)
    ).rejects.toMatchObject({ code: 'browser_error' })
  })

  it('does not send deferred termination after navigation replaces the document', async () => {
    const { bridge, first } = evaluationFixture()
    const events = captureGuestLifecycle(first)
    const controller = new AbortController()
    const evaluation = bridge.evaluate('pending', undefined, 'tab-1', controller.signal)
    const rejected = expect(evaluation).rejects.toMatchObject({ code: 'browser_cancelled' })
    await vi.waitFor(() => expect(events.listenerCount('did-navigate')).toBe(1))
    controller.abort()
    events.emit('did-navigate', {}, 'https://new.example')
    await rejected
    expect(first.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      'Runtime.evaluate'
    ])
    expect(events.eventNames()).toEqual([])
  })

  it('cancels only the old guest and preserves queue ownership after guest replacement', async () => {
    const { bridge, first, second, tabs } = evaluationFixture()
    const oldController = new AbortController()
    const previous = bridge.evaluate('old-document', undefined, 'tab-1', oldController.signal)
    const previousRejected = expect(previous).rejects.toMatchObject({ code: 'browser_cancelled' })
    const held = Promise.withResolvers<unknown>()
    second.debugger.sendCommand.mockImplementation(async (method) =>
      method === 'Runtime.evaluate' ? await held.promise : {}
    )
    tabs.set('tab-1', second.id)
    await bridge.onProcessSwap('tab-1', second.id, first.id)
    const current = bridge.evaluate('new-document', undefined, 'tab-1')
    oldController.abort()
    await previousRejected
    const move = bridge.mouseMove(10, 20, undefined, 'tab-1')
    await Promise.resolve()
    expect(second.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      'Runtime.evaluate'
    ])
    held.resolve({ result: { value: 42 } })
    await current
    await move
    expect(first.debugger.sendCommand).toHaveBeenCalledWith('Runtime.terminateExecution')
    expect(
      second.debugger.sendCommand.mock.calls.some(
        ([method]) => method === 'Runtime.terminateExecution'
      )
    ).toBe(false)
  })

  it('rejects an already aborted request without attaching or evaluating', async () => {
    const { bridge, first } = evaluationFixture()
    const controller = new AbortController()
    controller.abort()
    await expect(
      bridge.evaluate('unwanted', undefined, 'tab-1', controller.signal)
    ).rejects.toMatchObject({ code: 'browser_cancelled' })
    expect(first.debugger.sendCommand).not.toHaveBeenCalled()
    expect(first.debugger.attach).not.toHaveBeenCalled()
  })

  it('removes an aborted queued evaluation without affecting the running command', async () => {
    const { bridge, first } = evaluationFixture()
    const held = Promise.withResolvers<unknown>()
    first.debugger.sendCommand.mockReturnValue(held.promise)
    const move = bridge.mouseMove(10, 20, undefined, 'tab-1')
    const controller = new AbortController()
    const evaluation = bridge.evaluate('unwanted', undefined, 'tab-1', controller.signal)
    const rejected = expect(evaluation).rejects.toMatchObject({ code: 'browser_cancelled' })
    controller.abort()
    await rejected
    held.resolve({})
    await move
    expect(first.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      'Input.dispatchMouseEvent'
    ])
  })

  it('keeps SSH revocation attached to the queued evaluation', async () => {
    const { bridge, first } = evaluationFixture()
    const revoked = new AbortController()
    const evaluation = runInRemoteCliBrowserScope(
      'folder-workspace',
      () => bridge.evaluate('pending', undefined, 'tab-1'),
      revoked.signal
    )
    const rejected = expect(evaluation).rejects.toMatchObject({
      code: 'desktop_browser_bridge_unavailable'
    })
    await vi.waitFor(() =>
      expect(first.debugger.sendCommand).toHaveBeenCalledWith(
        'Runtime.evaluate',
        expect.any(Object)
      )
    )
    revoked.abort()
    await rejected
    expect(first.debugger.sendCommand).toHaveBeenCalledWith('Runtime.terminateExecution')
    await expect(bridge.mouseMove(10, 20, undefined, 'tab-1')).resolves.toEqual({ moved: true })
  })

  it('waits for termination acknowledgement before dispatching the next command', async () => {
    const { bridge, first } = evaluationFixture()
    const cancelled = Promise.withResolvers<unknown>()
    first.debugger.sendCommand.mockImplementation(async (method) => {
      if (method === 'Runtime.evaluate') {
        return await new Promise(() => {})
      }
      if (method === 'Runtime.terminateExecution') {
        return await cancelled.promise
      }
      return {}
    })
    const controller = new AbortController()
    const evaluation = bridge.evaluate('pending', undefined, 'tab-1', controller.signal)
    const rejected = expect(evaluation).rejects.toMatchObject({ code: 'browser_cancelled' })
    await vi.waitFor(() =>
      expect(first.debugger.sendCommand).toHaveBeenCalledWith(
        'Runtime.evaluate',
        expect.any(Object)
      )
    )
    const move = bridge.mouseMove(10, 20, undefined, 'tab-1')
    controller.abort()
    await vi.waitFor(() =>
      expect(first.debugger.sendCommand).toHaveBeenCalledWith('Runtime.terminateExecution')
    )
    expect(
      first.debugger.sendCommand.mock.calls.some(
        ([method]) => method === 'Input.dispatchMouseEvent'
      )
    ).toBe(false)
    cancelled.resolve({})
    await rejected
    await expect(move).resolves.toEqual({ moved: true })
  })

  it('bounds failed termination and rejects queued input until the original cancellation completes', async () => {
    vi.useFakeTimers()
    const { bridge, first } = evaluationFixture()
    const cancelled = Promise.withResolvers<unknown>()
    first.debugger.sendCommand.mockImplementation(async (method) => {
      if (method === 'Runtime.terminateExecution') {
        return await cancelled.promise
      }
      return await new Promise(() => {})
    })
    let evaluationFailure: unknown
    let inputFailure: unknown
    const evaluation = bridge.evaluate('pending', undefined, 'tab-1').catch((error) => {
      evaluationFailure = error
    })
    const move = bridge.mouseMove(10, 20, undefined, 'tab-1').catch((error) => {
      inputFailure = error
    })
    await vi.advanceTimersByTimeAsync(31_000)
    await evaluation
    await move
    expect(evaluationFailure).toMatchObject({
      code: 'browser_error',
      message: expect.stringContaining('could not be stopped')
    })
    expect(inputFailure).toBe(evaluationFailure)
    expect(first.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      'Runtime.evaluate',
      'Runtime.terminateExecution'
    ])
    cancelled.resolve({})
    await vi.advanceTimersByTimeAsync(0)
    first.debugger.sendCommand.mockResolvedValue({})
    await expect(bridge.mouseMove(10, 20, undefined, 'tab-1')).resolves.toEqual({ moved: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects navigation without terminating the replacement document', async () => {
    const { bridge, first } = evaluationFixture()
    const events = captureGuestLifecycle(first)
    const evaluation = bridge.evaluate('pending', undefined, 'tab-1')
    const rejected = expect(evaluation).rejects.toMatchObject({ code: 'browser_tab_changed' })
    await vi.waitFor(() => expect(events.listenerCount('did-navigate')).toBe(1))
    events.emit('did-navigate', {}, 'https://new.example')
    await rejected
    first.debugger.sendCommand.mockResolvedValue({ result: { value: 42 } })
    await expect(bridge.evaluate('6*7', undefined, 'tab-1')).resolves.toMatchObject({
      result: '42'
    })
    expect(
      first.debugger.sendCommand.mock.calls.some(
        ([method]) => method === 'Runtime.terminateExecution'
      )
    ).toBe(false)
    expect(events.eventNames()).toEqual([])
  })

  it('cleans up a completed evaluation so its old deadline cannot terminate later work', async () => {
    vi.useFakeTimers()
    const { bridge, first } = evaluationFixture()
    first.debugger.sendCommand.mockResolvedValue({ result: { value: 42 } })
    await expect(bridge.evaluate('6*7', undefined, 'tab-1')).resolves.toMatchObject({
      result: '42'
    })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(first.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      'Runtime.evaluate'
    ])
  })
  it.each([false, true])(
    'times out an evaluation and resumes its page queue (SSH scope=%s)',
    async (bridged) => {
      vi.useFakeTimers()
      const { bridge, first } = evaluationFixture()
      let failure: unknown
      const evaluate = () => bridge.evaluate('new Promise(() => {})', undefined, 'tab-1')
      const evaluation = (
        bridged ? runInRemoteCliBrowserScope('folder-workspace', evaluate) : evaluate()
      ).catch((error) => {
        failure = error
      })
      await vi.advanceTimersByTimeAsync(0)
      let moved = false
      const move = bridge.mouseMove(10, 20, undefined, 'tab-1').then(() => {
        moved = true
      })
      await bridge.mouseMove(20, 30, undefined, 'tab-2')
      expect(moved).toBe(false)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(failure).toMatchObject({ code: 'browser_timeout' })
      expect(first.debugger.sendCommand).toHaveBeenCalledWith('Runtime.terminateExecution')
      await evaluation
      await move
      expect(moved).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('cancels a running evaluation on request abort and lets a subsequent evaluation succeed', async () => {
    const { bridge, first } = evaluationFixture()
    const controller = new AbortController()
    let failure: unknown
    const evaluation = bridge
      .evaluate('pending', undefined, 'tab-1', controller.signal)
      .catch((error) => {
        failure = error
      })
    await vi.waitFor(() =>
      expect(first.debugger.sendCommand).toHaveBeenCalledWith(
        'Runtime.evaluate',
        expect.any(Object)
      )
    )
    controller.abort()
    await Promise.resolve()
    await Promise.resolve()
    await vi.waitFor(() => expect(failure).toMatchObject({ code: 'browser_cancelled' }))
    await evaluation
    first.debugger.sendCommand.mockResolvedValue({ result: { value: 42 } })
    await expect(bridge.evaluate('6*7', undefined, 'tab-1')).resolves.toMatchObject({
      result: '42'
    })
    expect(
      first.debugger.sendCommand.mock.calls.filter(
        ([method]) => method === 'Runtime.terminateExecution'
      )
    ).toHaveLength(1)
  })

  it('expires queued evaluations without executing them or cancelling the command ahead', async () => {
    vi.useFakeTimers()
    const { bridge, first } = evaluationFixture()
    const held = Promise.withResolvers<unknown>()
    first.debugger.sendCommand.mockImplementation(async (method) =>
      method === 'Input.dispatchMouseEvent' ? await held.promise : {}
    )
    const move = bridge.mouseMove(10, 20, undefined, 'tab-1')
    let failure: unknown
    const evaluation = bridge
      .evaluate('window.unwanted=true', undefined, 'tab-1')
      .catch((error) => {
        failure = error
      })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(failure).toMatchObject({ code: 'browser_timeout' })
    expect(first.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      'Input.dispatchMouseEvent'
    ])
    held.resolve({})
    await move
    await evaluation
    expect(first.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      'Input.dispatchMouseEvent'
    ])
    expect(vi.getTimerCount()).toBe(0)
  })
})
