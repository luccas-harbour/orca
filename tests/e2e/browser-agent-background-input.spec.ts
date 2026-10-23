import { test, expect } from './helpers/orca-app'
import {
  runAgentBackgroundWorkerScenario,
  runAgentDelayedGuardScenario,
  runAgentInactivePagesScenario,
  runAgentUnselectedPageScenario
} from './helpers/browser-agent-background-scenarios'

test.afterEach(async ({ electronApp }) => {
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})

for (const otherWorkspace of [false, true]) {
  test(`agent keys and text reach inactive pages in ${otherWorkspace ? 'another workspace' : 'the current workspace'}`, async ({
    orcaPage
  }) => {
    test.setTimeout(120_000)
    await runAgentInactivePagesScenario(orcaPage, otherWorkspace)
  })
}

test('background pointer input survives a short hosting-renderer stall', async ({ orcaPage }) => {
  test.setTimeout(120_000)
  await runAgentDelayedGuardScenario(orcaPage)
})

test('agent keys and text reach a page never selected in the desktop UI', async ({ orcaPage }) => {
  test.setTimeout(120_000)
  await runAgentUnselectedPageScenario(orcaPage)
})

test('a worker starts and replies in a page never selected in the desktop UI', async ({
  orcaPage
}) => {
  test.setTimeout(120_000)
  await runAgentBackgroundWorkerScenario(orcaPage)
})
