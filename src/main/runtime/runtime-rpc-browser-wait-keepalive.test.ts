import './rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { BROWSER_WAIT_CAP } from './runtime-rpc/runtime-rpc-long-poll'
import { readRuntimeMetadata } from './runtime-metadata'
import { createLongPollServer } from './runtime-rpc-long-poll-server.test-fixture'
import { openFramedSession, waitFor } from './runtime-rpc-test-harness'

it('aborts a browser evaluation when its local CLI connection ends without enabling keepalive', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-browser-eval-abort-'))
  const runtime = new OrcaRuntimeService()
  const server = createLongPollServer({ runtime, userDataPath, keepaliveIntervalMs: 20 })
  const response = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  const dispatch = vi
    .spyOn(server['dispatcher'], 'dispatch')
    .mockImplementation(async (incoming, options) => {
      signal = options?.signal
      await response.promise
      return { id: incoming.id, ok: true, result: {}, _meta: { runtimeId: runtime.getRuntimeId() } }
    })
  try {
    await server.start()
    const metadata = readRuntimeMetadata(userDataPath)
    if (!metadata?.transports[0]) {
      throw new Error('Missing test runtime transport')
    }
    const session = openFramedSession(metadata.transports[0].endpoint, {
      id: 'browser-eval',
      authToken: metadata.authToken,
      method: 'browser.eval',
      params: { expression: 'pending' }
    })
    await waitFor(() => dispatch.mock.calls.length === 1)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
    expect(session.frames).toEqual([])
    session.socket.destroy()
    await session.done
    await waitFor(() => signal?.aborted === true)
  } finally {
    response.resolve()
    await server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})

it.each([false, true])(
  'keeps browser waits alive with long-poll capacity occupied=%s',
  async (occupied) => {
    const request = {
      id: 'browser-wait',
      authToken: 'token',
      method: 'browser.wait',
      params: { worktree: 'folder:example', page: 'page-1', text: 'ready', timeout: 60_000 }
    }
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-browser-wait-'))
    const runtime = new OrcaRuntimeService()
    const server = createLongPollServer({
      runtime,
      userDataPath,
      keepaliveIntervalMs: 20,
      longPollCap: 1
    })
    const browserResponse = Promise.withResolvers<void>()
    const holderResponse = Promise.withResolvers<void>()
    const dispatch = vi
      .spyOn(server['dispatcher'], 'dispatch')
      .mockImplementation(async (incoming) => {
        await (incoming.method === 'browser.wait'
          ? browserResponse.promise
          : holderResponse.promise)
        return {
          id: incoming.id,
          ok: true,
          result: { waited: 'text', text: 'ready' },
          _meta: { runtimeId: runtime.getRuntimeId() }
        }
      })
    try {
      await server.start()
      const metadata = readRuntimeMetadata(userDataPath)
      if (!metadata?.transports[0]) {
        throw new Error('Missing test runtime transport')
      }
      if (occupied) {
        openFramedSession(metadata.transports[0].endpoint, {
          id: 'held-wait',
          authToken: metadata.authToken,
          method: 'terminal.wait',
          params: { terminal: 'test-terminal', timeoutMs: 60_000 }
        })
        await waitFor(() => dispatch.mock.calls.some(([incoming]) => incoming.id === 'held-wait'))
      }
      const session = openFramedSession(metadata.transports[0].endpoint, {
        ...request,
        authToken: metadata.authToken
      })
      await waitFor(() => session.frames.filter((frame) => frame._keepalive === true).length >= 2)
      browserResponse.resolve()
      await session.done
      expect(session.frames.filter((frame) => frame.ok !== undefined)).toEqual([
        expect.objectContaining({
          id: request.id,
          ok: true,
          result: { waited: 'text', text: 'ready' }
        })
      ])
    } finally {
      browserResponse.resolve()
      holderResponse.resolve()
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }
)

it('bounds browser waits, preserves short-call capacity, and releases completed slots', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-browser-wait-cap-'))
  const runtime = new OrcaRuntimeService()
  const server = createLongPollServer({ runtime, userDataPath, keepaliveIntervalMs: 20 })
  const response = Promise.withResolvers<void>()
  const dispatch = vi
    .spyOn(server['dispatcher'], 'dispatch')
    .mockImplementation(async (incoming) => {
      if (incoming.method === 'browser.wait') {
        await response.promise
      }
      return { id: incoming.id, ok: true, result: {}, _meta: { runtimeId: runtime.getRuntimeId() } }
    })
  try {
    await server.start()
    const metadata = readRuntimeMetadata(userDataPath)
    if (!metadata?.transports[0]) {
      throw new Error('Missing test runtime transport')
    }
    const endpoint = metadata.transports[0].endpoint
    const request = { authToken: metadata.authToken, method: 'browser.wait', params: {} }
    const pending = Array.from({ length: BROWSER_WAIT_CAP }, (_, index) =>
      openFramedSession(endpoint, { ...request, id: `browser-${index}` })
    )
    await waitFor(() => dispatch.mock.calls.length === BROWSER_WAIT_CAP)

    const overloaded = openFramedSession(endpoint, { ...request, id: 'overloaded' })
    await overloaded.done
    expect(overloaded.frames).toContainEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'runtime_busy' })
      })
    )

    const shortCall = openFramedSession(endpoint, {
      ...request,
      id: 'short-call',
      method: 'terminal.list'
    })
    await shortCall.done
    expect(shortCall.frames).toContainEqual(expect.objectContaining({ ok: true }))

    response.resolve()
    await Promise.all(pending.map((session) => session.done))
    const next = openFramedSession(endpoint, { ...request, id: 'after-completion' })
    await next.done
    expect(next.frames).toContainEqual(expect.objectContaining({ ok: true }))
  } finally {
    response.resolve()
    await server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
