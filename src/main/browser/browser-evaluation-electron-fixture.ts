import { app, BrowserWindow, type WebContents } from 'electron'
import { applyBackgroundActivationPolicy } from '../window/foreground-activation-policy'
import { AgentBrowserBridge } from './agent-browser-bridge'
import type { BrowserManager } from './browser-manager'
import { createServer } from 'node:http'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Evaluation fixture requires background launch')
}
applyBackgroundActivationPolicy()

async function run(): Promise<void> {
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    webPreferences: { webviewTag: true, backgroundThrottling: false }
  })
  const guests: WebContents[] = []
  const attached = Promise.withResolvers<void>()
  window.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setBackgroundThrottling(false)
    guests.push(guest)
    if (guests.length === 2) {
      attached.resolve()
    }
  })
  const url = `data:text/html,${encodeURIComponent('<button style="width:120px;height:60px" onclick="window.clicks=(window.clicks||0)+1">Target</button>')}`
  await window.loadURL(
    `data:text/html,${encodeURIComponent(`
    <webview partition="evaluation-first" style="width:400px;height:200px" src="${url}"></webview>
    <webview partition="evaluation-second" style="width:400px;height:200px" src="${url}"></webview>
  `)}`
  )
  await attached.promise
  await Promise.all(
    guests.map(async (guest) => {
      if (guest.isLoading()) {
        await new Promise<void>((resolve) => guest.once('did-finish-load', () => resolve()))
      }
    })
  )
  const [first, second] = guests
  const tabs = new Map([
    ['first', first.id],
    ['second', second.id]
  ])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: direct evaluation and pointer commands only use these BrowserManager methods.
  const manager = {
    getWebContentsIdByTabId: () => tabs,
    getTabIdForWebContentsId: (id: number) =>
      [...tabs].find(([, guestId]) => guestId === id)?.[0] ?? null,
    getWorktreeIdForTab: () => 'folder-workspace',
    getGuestWebContentsId: (id: string) => tabs.get(id) ?? null,
    getBrowserPageLoadError: () => null,
    getBrowserPageCertificateFailure: () => null,
    guardUserFocusForAgentInput: async () => () => {}
  } as unknown as BrowserManager
  const bridge = new AgentBrowserBridge(manager)
  const results: unknown[] = []
  for (const expression of ['new Promise(() => {})', 'while (true) {}', 'new Promise(() => {})']) {
    const controller = new AbortController()
    const evaluation = bridge.evaluate(expression, undefined, 'first', controller.signal).then(
      () => 'unexpected-success',
      (error: unknown) => (error instanceof Error && 'code' in error ? error.code : String(error))
    )
    const timer = setTimeout(() => controller.abort(), 100)
    const other = await bridge.evaluate('6 * 7', undefined, 'second')
    const cancelled = await evaluation
    clearTimeout(timer)
    const next = await bridge.evaluate('6 * 7', undefined, 'first')
    await bridge.mouseMove(30, 30, undefined, 'first')
    await bridge.mouseDown('left', undefined, 'first')
    await bridge.mouseUp('left', undefined, 'first')
    const clicks = await bridge.evaluate('window.clicks', undefined, 'first')
    results.push({
      expression,
      cancelled,
      other: other.result,
      next: next.result,
      clicks: clicks.result
    })
  }
  const navigating = bridge.evaluate('new Promise(() => {})', undefined, 'first').then(
    () => 'unexpected-success',
    (error: unknown) => (error instanceof Error && 'code' in error ? error.code : String(error))
  )
  await first.loadURL('data:text/html,<p>replacement document</p>')
  const navigation = await navigating
  const afterNavigation = await bridge.evaluate('6 * 7', undefined, 'first')
  let noContentRequested = false
  const server = createServer((request, response) => {
    if (request.url === '/no-content') {
      noContentRequested = true
      response.writeHead(204)
      response.end()
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<p>navigation control</p>')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing diagnostic server address')
  }
  await first.loadURL(`http://127.0.0.1:${address.port}/control`)
  const originalURL = first.getURL()
  const controller = new AbortController()
  let settledBeforeAbort = false
  const pending = bridge
    .evaluate('new Promise(() => {})', undefined, 'first', controller.signal)
    .then(
      () => {
        settledBeforeAbort = true
        return 'unexpected-success'
      },
      (error: unknown) => {
        settledBeforeAbort = true
        return error instanceof Error && 'code' in error ? error.code : String(error)
      }
    )
  try {
    await first.loadURL(`http://127.0.0.1:${address.port}/no-content`)
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      (error.code !== 'ERR_ABORTED' && error.code !== 'ERR_FAILED')
    ) {
      throw error
    }
  }
  const noContent = {
    requested: noContentRequested,
    settledBeforeAbort,
    urlUnchanged: first.getURL() === originalURL
  }
  controller.abort()
  const noContentCancellation = await pending
  const afterNoContent = await bridge.evaluate('6 * 7', undefined, 'first')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  console.log(
    `EVALUATION_RESULT:${JSON.stringify({ hidden: !window.isVisible(), electron: process.versions.electron, navigation, afterNavigation: afterNavigation.result, noContent: { ...noContent, cancelled: noContentCancellation, next: afterNoContent.result }, results })}`
  )
  window.destroy()
  app.exit(0)
}

void run().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
