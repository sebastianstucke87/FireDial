import { chromeFor } from './chrome.ts'
import type { Browser } from './shared.ts'

// Edge is Chrome underneath. Its own store is closed to add-ons; Chrome's isn't, in Edge.
export const edge: Browser = {
  ...chromeFor('Edge'),
  closedSites: new Set(['https://microsoftedge.microsoft.com'])
}
