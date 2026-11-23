// The browser FireDial runs in, picked once when FireDial starts. Imported first by every entry
// point, so the rest of FireDial uses browser.* only and asks currentBrowser what differs.

import { browserFor } from './factory.ts'

export { ALL_SITES } from './shared.ts'
export type { BookmarkTree } from './shared.ts'

export const currentBrowser = browserFor(globalThis, Reflect.get(navigator, 'userAgentData'))
