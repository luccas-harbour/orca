export const expectedSecurity = { sandbox: true, contextIsolation: true, nodeIntegration: false }

export type PopupFixtureStatus = {
  revision: number
  ready?: boolean
  error?: string
  windowsHidden: boolean
  tabOpens: { url: string; activate: boolean }[]
  blocked: number[]
  inputs: string[]
  browserReloads: Record<string, { completed: number; error?: string }>
  childRequests: {
    adopted: boolean
    native: boolean
    sessionMatches: boolean
    security: typeof expectedSecurity
    permission?: string
  }[]
  routeGranted: boolean
  routeContents: { security: typeof expectedSecurity; webRtcPolicy: string }[]
  native: {
    presentationCalls: string[]
    requests: { disposition: string; features: string; frameName: string; post: boolean }[]
    creation: {
      firstNavigationPolicy: string
      firstNavigationOwner: number | null
      firstNavigationTitle: string
    }[]
    windows: {
      closed: boolean
      title: string
      fullscreen: boolean
      focused: boolean
      contentSize: number[]
    }[]
  }
}
