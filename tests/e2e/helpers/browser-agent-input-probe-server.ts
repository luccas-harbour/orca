import { createServer, type Server } from 'node:http'

const PAGE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Focus isolation probe</title></head>
  <body>
    <form id="form"><input id="probe" /></form>
    <textarea id="notes"></textarea>
    <button id="target" style="position:absolute;left:40px;top:80px;width:200px;height:60px">target</button>
    <iframe id="frame" src="__FRAME_URL__" style="position:absolute;left:40px;top:200px;width:300px;height:80px"></iframe>
    <script>
      window.__frameValue = ''
      window.__frameKeys = []
      window.__frameReady = false
      addEventListener('message', (event) => {
        if (typeof event.data?.frameValue === 'string') window.__frameValue = event.data.frameValue
        if (typeof event.data?.frameKey === 'string') window.__frameKeys.push(event.data.frameKey)
        if (event.data?.frameReady) window.__frameReady = true
      })
      window.__keys = []
      window.__submits = 0
      window.__clicks = 0
      window.__blurs = 0
      document.getElementById('probe').addEventListener('blur', () => { window.__blurs += 1 })
      addEventListener('keydown', (event) => window.__keys.push(event.key), true)
      document.getElementById('form').addEventListener('submit', (event) => {
        event.preventDefault()
        window.__submits += 1
      })
      document.getElementById('target').addEventListener('click', () => { window.__clicks += 1 })
    </script>
  </body>
</html>`

// Why: served from localhost while the page is on 127.0.0.1, so it is cross-site and Chromium puts
// it in its own process, the case widget input cannot reach.
const FRAME_HTML = `<!doctype html>
<html>
  <body>
    <input id="field" style="position:absolute;left:0;top:0;width:280px;height:60px" />
    <script>
      const field = document.getElementById('field')
      // Why: a cross-site frame cannot focus itself without user activation, so the field takes
      // focus on the first key the frame receives.
      addEventListener(
        'keydown',
        (event) => {
          if (document.activeElement !== field) field.focus()
          parent.postMessage({ frameKey: event.key }, '*')
        },
        true
      )
      field.addEventListener('input', () => parent.postMessage({ frameValue: field.value }, '*'))
      parent.postMessage({ frameReady: true }, '*')
    </script>
  </body>
</html>`

export async function startProbeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const address = server.address()
    const port = address !== null && typeof address === 'object' ? address.port : 0
    response.end(
      request.url === '/frame'
        ? FRAME_HTML
        : PAGE_HTML.replace('__FRAME_URL__', `http://localhost:${port}/frame`)
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Probe server did not bind a TCP port')
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Why: the page and its cross-site frame hold keep-alive sockets; on Windows close()
        // otherwise waits for them until the test times out.
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}
