import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock, stdinWrites } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    webContentsFromIdMock: vi.fn(),
    existsSyncMock: vi.fn(() => false),
    readFileSyncMock: vi.fn(() => Buffer.from('')),
    stdinWrites: [] as string[]
  }))

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockClass = vi.fn().mockImplementation(function (this: any, _wc: unknown) {
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
import {
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

describe('AgentBrowserBridge', () => {
  let bridge: AgentBrowserBridge

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  it('guards the user’s focus instead of focusing an embedded guest on click', async () => {
    const release = vi.fn()
    const guardUserFocusForAgentInput = vi.fn(async () => release)
    bridge = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, { guardUserFocusForAgentInput })
    )
    bridge.setActiveTab(100)
    const wc = mockWebContents(100)
    wc.getType.mockReturnValue('webview')
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Input.dispatchMouseEvent') {
        expect(release).not.toHaveBeenCalled()
      }
      return method === 'Runtime.evaluate' ? { result: { value: null } } : {}
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await bridge.mouseClick(10, 20, 'left', undefined, 'tab-1')

    expect(wc.focus).not.toHaveBeenCalled()
    expect(guardUserFocusForAgentInput).toHaveBeenCalledWith(100)
    expect(release).toHaveBeenCalledTimes(1)
    expect(
      wc.debugger.sendCommand.mock.calls.filter((call) => call[0] === 'Input.dispatchMouseEvent')
    ).toHaveLength(2)
  })

  it('uses the runtime mobile tap path when a nearby DOM target is handled', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 12, y: 34, adjusted: true, handled: true } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)

    const result = await bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18)

    expect(result).toEqual({
      clicked: { x: 12, y: 34, button: 'left', adjusted: true, handled: true }
    })
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ returnByValue: true, silent: true })
    )
    expect(
      wc.debugger.sendCommand.mock.calls.some((call) => call[0] === 'Input.dispatchMouseEvent')
    ).toBe(false)
  })

  it.each(['mouseDown', 'mouseClick'] as const)(
    'refuses %s when its page changes guests while the focus guard is pending',
    async (command) => {
      const tabs = new Map([['tab-1', 100]])
      const original = mockWebContents(100)
      const replacement = mockWebContents(200)
      original.getType.mockReturnValue('webview')
      replacement.getType.mockReturnValue('webview')
      original.debugger.sendCommand.mockResolvedValue({})
      replacement.debugger.sendCommand.mockResolvedValue({})
      webContentsFromIdMock.mockImplementation((id: number) =>
        id === 100 ? original : id === 200 ? replacement : null
      )
      const ready = Promise.withResolvers<() => void>()
      const release = vi.fn()
      const guardUserFocusForAgentInput = vi.fn(() => ready.promise)
      bridge = new AgentBrowserBridge(
        mockBrowserManager(tabs, undefined, { guardUserFocusForAgentInput })
      )
      await bridge.mouseMove(30, 40, undefined, 'tab-1')
      original.debugger.sendCommand.mockClear()

      const input =
        command === 'mouseDown'
          ? bridge.mouseDown('left', undefined, 'tab-1')
          : bridge.mouseClick(30, 40, 'left', undefined, 'tab-1')
      const outcome = input.then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error })
      )
      await vi.waitFor(() => expect(guardUserFocusForAgentInput).toHaveBeenCalledWith(100))

      // The retired guest can remain alive while its page is already owned by a replacement.
      tabs.set('tab-1', 200)
      await bridge.onProcessSwap('tab-1', 200, 100)
      ready.resolve(release)
      const result = await outcome

      expect(release).toHaveBeenCalledTimes(1)
      expect.soft(result).toMatchObject({
        ok: false,
        error: { code: 'browser_tab_changed' }
      })
      expect(
        original.debugger.sendCommand.mock.calls.filter(
          ([method]) => method === 'Input.dispatchMouseEvent'
        )
      ).toEqual([])
      expect(replacement.debugger.sendCommand).not.toHaveBeenCalled()
      if (command === 'mouseDown') {
        tabs.set('tab-1', 100)
        await bridge.onProcessSwap('tab-1', 100, 200)
        await bridge.mouseMove(35, 45, undefined, 'tab-1')
        expect(original.debugger.sendCommand).toHaveBeenLastCalledWith(
          'Input.dispatchMouseEvent',
          expect.objectContaining({ button: 'none', buttons: 0 })
        )
      }
    }
  )

  it.each(['mouseDown', 'mouseClick'] as const)(
    'does not acknowledge %s after its guest changes during dispatch',
    async (command) => {
      const tabs = new Map([['tab-1', 100]])
      const original = mockWebContents(100)
      const replacement = mockWebContents(200)
      original.getType.mockReturnValue('webview')
      const release = vi.fn()
      const guardUserFocusForAgentInput = vi.fn(async () => release)
      webContentsFromIdMock.mockImplementation((id: number) =>
        id === 100 ? original : id === 200 ? replacement : null
      )
      bridge = new AgentBrowserBridge(
        mockBrowserManager(tabs, undefined, { guardUserFocusForAgentInput })
      )
      const dispatched = Promise.withResolvers<void>()
      const acknowledgement = Promise.withResolvers<unknown>()
      original.debugger.sendCommand.mockImplementation(async (method) => {
        if (method === 'Input.dispatchMouseEvent') {
          dispatched.resolve()
          return acknowledgement.promise
        }
        return {}
      })
      const input =
        command === 'mouseDown'
          ? bridge.mouseDown('left', undefined, 'tab-1')
          : bridge.mouseClick(30, 40, 'left', undefined, 'tab-1')
      const outcome = input.then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error })
      )
      await dispatched.promise
      tabs.set('tab-1', 200)
      await bridge.onProcessSwap('tab-1', 200, 100)
      acknowledgement.resolve({})

      expect(await outcome).toMatchObject({ ok: false, error: { code: 'browser_tab_changed' } })
      expect(release).toHaveBeenCalledTimes(1)
      expect(replacement.debugger.sendCommand).not.toHaveBeenCalled()
      if (command === 'mouseClick') {
        expect(original.debugger.sendCommand).toHaveBeenLastCalledWith(
          'Input.dispatchMouseEvent',
          expect.objectContaining({ type: 'mouseReleased', buttons: 0 })
        )
      } else {
        tabs.set('tab-1', 100)
        await bridge.onProcessSwap('tab-1', 100, 200)
        await bridge.mouseMove(35, 45, undefined, 'tab-1')
        expect(original.debugger.sendCommand).toHaveBeenLastCalledWith(
          'Input.dispatchMouseEvent',
          expect.objectContaining({ button: 'left', buttons: 1 })
        )
        await bridge.mouseUp('left', undefined, 'tab-1')
      }
    }
  )

  it('falls back to CDP mouse events when runtime does not handle a mobile tap', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 10, y: 20, adjusted: false, handled: false } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18)).resolves.toEqual({
      clicked: { x: 10, y: 20, button: 'left', adjusted: false, handled: false }
    })

    const mouseCalls = wc.debugger.sendCommand.mock.calls.filter(
      (call) => call[0] === 'Input.dispatchMouseEvent'
    )
    expect(mouseCalls).toHaveLength(2)
    expect(mouseCalls[0]?.[1]).toMatchObject({ type: 'mousePressed', x: 10, y: 20 })
    expect(mouseCalls[1]?.[1]).toMatchObject({ type: 'mouseReleased', x: 10, y: 20 })
  })

  it('passes mobile click modifiers through to CDP mouse events', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 10, y: 20, adjusted: false, handled: false } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18, ['cmd', 'shift'])

    const mouseCalls = wc.debugger.sendCommand.mock.calls.filter(
      (call) => call[0] === 'Input.dispatchMouseEvent'
    )
    expect(mouseCalls[0]?.[1]).toMatchObject({ type: 'mousePressed', modifiers: 12 })
    expect(mouseCalls[1]?.[1]).toMatchObject({ type: 'mouseReleased', modifiers: 12 })
  })

  it('keeps adjusted mobile tap coordinates but uses CDP for modifier clicks', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 12, y: 34, adjusted: true, handled: false } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(
      bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18, ['cmd'])
    ).resolves.toEqual({
      clicked: { x: 12, y: 34, button: 'left', adjusted: true, handled: false }
    })

    const evaluateCall = wc.debugger.sendCommand.mock.calls.find(
      (call) => call[0] === 'Runtime.evaluate'
    )
    expect((evaluateCall?.[1] as { expression?: string } | undefined)?.expression).toContain(
      'const allowDomActivation = false'
    )
    const mouseCalls = wc.debugger.sendCommand.mock.calls.filter(
      (call) => call[0] === 'Input.dispatchMouseEvent'
    )
    expect(mouseCalls).toHaveLength(2)
    expect(mouseCalls[0]?.[1]).toMatchObject({ type: 'mousePressed', x: 12, y: 34, modifiers: 4 })
    expect(mouseCalls[1]?.[1]).toMatchObject({ type: 'mouseReleased', x: 12, y: 34, modifiers: 4 })
  })

  it('drops empty command queues after direct CDP commands finish', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockResolvedValue({})
    webContentsFromIdMock.mockReturnValue(wc)

    await bridge.mouseClick(10, 20, 'right', undefined, 'tab-1')

    expect(
      (bridge as unknown as { commandQueues: Map<string, unknown[]> }).commandQueues.size
    ).toBe(0)
    expect((bridge as unknown as { processingQueues: Set<string> }).processingQueues.size).toBe(0)
  })
})
