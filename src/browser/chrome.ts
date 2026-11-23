import { blobToDataUrl, faviconPath } from '../images.ts'
import { ALL_SITES } from './shared.ts'
import type { Browser, BookmarkTree } from './shared.ts'

// Chrome has no type and no separators: a folder is a node without an address. Other Bookmarks is
// marked by a folder type; signed in, there are two, and the one that syncs to the account wins
// over the one on this device only.
export const chromeBookmarks: BookmarkTree = {
  isFolder: (node) => node.url == null,
  isBookmark: (node) => typeof node.url === 'string',
  isOtherBookmarks: (node) => node.folderType === 'other',
  otherBookmarks: (tops) => {
    const others = tops.filter((node) => node.folderType === 'other')
    return others.find((node) => node.syncing === true) ?? others[0]
  }
}

// Chrome and the browsers made from it. product is what the user knows it as ("Chrome", "Brave").
export const chromeFor = (product: string): Browser => ({
  name: 'Chrome',
  product,
  // Chrome has no menu on tabs.
  menuContexts: ['all'],
  bookmarks: chromeBookmarks,
  closedSites: new Set(['https://chrome.google.com', 'https://chromewebstore.google.com']),
  // Chrome keeps the icons of sites it has been to, which need no site access.
  keepsIcons: true,
  iconOf: async (pageUrl) => {
    try {
      const response = await fetch(browser.runtime.getURL(faviconPath(pageUrl, 64)))
      return response.ok ? await blobToDataUrl(await response.blob()) : ''
    } catch {
      return ''
    }
  },
  // Chrome only captures the tab in front: the page shows, with the note once it's captured.
  previewInFront: true,
  capture: (tab) => browser.tabs.captureVisibleTab(tab.windowId ?? browser.windows.WINDOW_ID_CURRENT, { format: 'jpeg', quality: 85 }),
  noteOnPage: (show) => show(),
  backTo: async (home) => {
    if (home?.id !== undefined) await browser.tabs.update(home.id, { active: true }).catch(() => undefined)
  },
  // Access to the sites, so the sparks synced in get their icons; sync starts either way.
  askSyncAccess: async () => {
    await browser.permissions.request(ALL_SITES).catch(() => false)
    return true
  },
  dropSyncAccess: () => Promise.resolve(),
  // Chrome can't list the search engines: there's only its default one.
  searchEngines: () => Promise.resolve([]),
  searchWeb: (search, query) => search.query({ text: query, disposition: 'CURRENT_TAB' }),
  // In web pages, older Chrome has no browser.*, only chrome.*.
  pageApi: 'chrome'
})
