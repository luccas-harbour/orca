import { runProcess } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { build } from 'vite'
import { resolveElectronProbeLaunch } from './electron-probe-display-launch'

it('recovers the same guest after pending promises and CPU-bound evaluations are cancelled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-browser-evaluation-'))
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        lib: {
          entry: join(__dirname, 'browser-evaluation-electron-fixture.ts'),
          formats: ['cjs'],
          fileName: () => 'main.cjs'
        },
        outDir: root,
        emptyOutDir: false,
        target: 'node22',
        rollupOptions: { external: ['electron', /^node:/] }
      }
    })
    const electronBinary: unknown = createRequire(import.meta.url)('electron')
    if (typeof electronBinary !== 'string') {
      throw new Error('Missing Electron executable')
    }
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
    const launch = resolveElectronProbeLaunch({
      electronBinary,
      electronArgs: [join(root, 'main.cjs'), `--user-data-dir=${join(root, 'profile')}`],
      platform: process.platform,
      display: env.DISPLAY
    })
    const result = await runProcess({
      program: launch.executable,
      args: launch.args,
      env: { ...env, ORCA_BACKGROUND_LAUNCH: '1', AGENT_BROWSER_SOCKET_DIR: join(root, 'sockets') },
      timeoutMs: 20_000,
      detached: process.platform !== 'win32',
      maxOutputBytes: 64 * 1024
    })
    expect(result.timedOut, result.stdout + result.stderr).toBe(false)
    expect(result.code, result.stdout + result.stderr).toBe(0)
    const line = result.stdout.split('\n').find((line) => line.startsWith('EVALUATION_RESULT:'))
    expect(line).toBeDefined()
    const evidence: unknown = JSON.parse(line?.slice('EVALUATION_RESULT:'.length) ?? 'null')
    expect(evidence, result.stderr).toEqual({
      hidden: true,
      electron: expect.any(String),
      navigation: 'browser_tab_changed',
      afterNavigation: '42',
      noContent: {
        requested: true,
        settledBeforeAbort: false,
        urlUnchanged: true,
        cancelled: 'browser_cancelled',
        next: '42'
      },
      results: ['new Promise(() => {})', 'while (true) {}', 'new Promise(() => {})'].map(
        (expression, index) => ({
          expression,
          cancelled: 'browser_cancelled',
          other: '42',
          next: '42',
          clicks: String(index + 1)
        })
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 45_000)
