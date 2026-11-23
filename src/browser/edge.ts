import { chromeFor } from './chrome.ts'
import type { Browser } from './shared.ts'

// Edge is Chrome underneath. Its own store is closed to add-ons; Chrome's isn't, in Edge.
const chromium = chromeFor('Edge')

export const edge: Browser = {
  ...chromium,
  name: 'Edge',
  closedSites: new Set(['https://microsoftedge.microsoft.com'])
}
