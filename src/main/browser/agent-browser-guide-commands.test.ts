import { runProcess } from '@orca/process-host'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { resolveAgentBrowserBinary } from './agent-browser-bridge-process'

vi.mock('electron', () => ({
  app: { getPath: () => process.execPath, getAppPath: () => process.cwd() }
}))

it('documents browser passthrough commands supported by the installed helper', async () => {
  const reference = readFileSync(
    join(process.cwd(), 'skill-guides/orca-cli/references/browser.md'),
    'utf8'
  )
  expect(reference).toContain('# Built-in browser commands')
  const examples = [...reference.matchAll(/ORCA exec --command "([^"]+)"/g)]
    .map((match) => match[1])
    .filter((command) => !command.includes('<'))

  // --help reads the real command catalog without starting a daemon or opening a browser.
  const binary = resolveAgentBrowserBinary()
  expect(existsSync(binary), `Missing bundled helper for ${process.platform}-${process.arch}`).toBe(
    true
  )
  const result = await runProcess({
    program: binary,
    args: ['--help'],
    timeoutMs: 5_000
  })
  expect(result.code, result.stderr).toBe(0)
  const optionsStart = result.stdout.indexOf('\nOptions:')
  expect(optionsStart).toBeGreaterThan(0)
  const catalog = result.stdout.slice(0, optionsStart)
  const commands = new Set(
    [...catalog.matchAll(/^  ([a-z][a-z0-9-]*)\b[^\n]*? {2,}\S/gm)].map((match) => match[1])
  )
  for (const match of catalog.matchAll(/^[^\n:]+:[ \t]+agent-browser ([a-z][a-z0-9-]*)\b/gm)) {
    commands.add(match[1])
  }
  for (const command of ['snapshot', 'mouse', 'get', 'is', 'find', 'set', 'network']) {
    expect(commands.has(command), `Missing command group: ${command}`).toBe(true)
  }
  for (const subcommand of [
    'move',
    'route',
    'viewport',
    'agent-browser',
    'npm',
    'brew',
    'cargo',
    'looks'
  ]) {
    expect(
      commands.has(subcommand),
      `Accepted a subcommand as a top-level command: ${subcommand}`
    ).toBe(false)
  }
  const unsupported = examples.filter((example) => !commands.has(example.split(' ')[0]))

  expect(unsupported).toEqual([])
})
