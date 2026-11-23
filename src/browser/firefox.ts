import { ALL_SITES } from './shared.ts'
import type { Browser, BookmarkTree } from './shared.ts'

// What sync sends to Drive, in Firefox's words: sparks are bookmarks, previews show web pages.
export const SYNC_DATA: browser._manifest.OptionalDataCollectionPermission[] = ['bookmarksInfo', 'websiteContent']

const OTHER = 'unfiled_____' // Firefox's Other Bookmarks

// Firefox tells folders, bookmarks and separators by type; nodes from older Firefox have none.
export const firefoxBookmarks: BookmarkTree = {
  isFolder: (node) => node.type === 'folder' || (node.type === undefined && node.url == null),
  isBookmark: (node) => node.type === 'bookmark' || (node.type === undefined && typeof node.url === 'string'),
  isOtherBookmarks: (node) => node.id === OTHER,
  otherBookmarks: (tops) => tops.find((node) => node.id === OTHER)
}

export const firefox: Browser = {
  product: 'Firefox',
  menuContexts: ['all', 'tab'],
  bookmarks: firefoxBookmarks,
  closedSites: new Set(),
  // Firefox gives the tab's icon itself, and keeps no copies to ask for.
  keepsIcons: false,
  iconOf: () => Promise.resolve(''),
  // Firefox captures a tab in the background, so FireDial and its card stay in front.
  previewInFront: false,
  capture: (tab) => browser.tabs.captureTab(tab.id ?? browser.tabs.TAB_ID_NONE, { format: 'jpeg', quality: 85 }),
  noteOnPage: () => Promise.resolve(),
  backTo: () => Promise.resolve(),
  // Sync also asks whether FireDial may send sparks and previews off the computer: without it, no sync.
  askSyncAccess: () => browser.permissions.request({ ...ALL_SITES, data_collection: SYNC_DATA }).catch(() => false),
  dropSyncAccess: async () => {
    await browser.permissions.remove({ data_collection: SYNC_DATA }).catch(() => false)
  },
  searchEngines: async (search) => (await search.get?.()) ?? [],
  searchWeb: async (search, query, engine) => {
    await search.search({ query, ...(engine === undefined ? {} : { engine }), disposition: 'CURRENT_TAB' })
  },
  pageApi: 'browser'
}
