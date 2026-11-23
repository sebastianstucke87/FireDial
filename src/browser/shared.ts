// What FireDial does differently in each browser, behind one interface: index.ts picks the
// browser once, and the rest of FireDial asks it instead of checking which browser it is in.

// Access to all sites: for icons, previews and images from the web. Kept once given.
export const ALL_SITES = { origins: ['<all_urls>'] }

interface SearchApi {
  get?: (() => Promise<browser.search.SearchEngine[]>) | undefined
  search(details: { query: string; engine?: string; disposition: 'CURRENT_TAB' }): Promise<unknown>
  query(details: { text: string; disposition: 'CURRENT_TAB' }): Promise<void>
}

// The parts of a bookmark node that differ between the browsers.
interface NodeShape {
  id: string
  type?: string | undefined // Firefox only
  folderType?: string | undefined // Chrome only
  syncing?: boolean | undefined // Chrome only
  url?: string | null | undefined
}

// How the browser's bookmark tree tells folders, bookmarks and Other Bookmarks apart.
export interface BookmarkTree {
  isFolder(node: Pick<NodeShape, 'type' | 'url'>): boolean
  isBookmark(node: Pick<NodeShape, 'type' | 'url'>): boolean
  isOtherBookmarks(node: Pick<NodeShape, 'id' | 'folderType'>): boolean
  // Other Bookmarks among the tree's top folders, where FireDial's folder goes.
  otherBookmarks<T extends NodeShape>(tops: readonly T[]): T | undefined
}

type Tab = Pick<browser.tabs.Tab, 'id' | 'windowId'>

export interface Browser {
  readonly product: string // the browser as the user knows it, for the Sync section's device name
  readonly menuContexts: browser.menus.ContextType[]
  readonly bookmarks: BookmarkTree
  // Sites the browser keeps closed to add-ons, site access or not.
  readonly closedSites: ReadonlySet<string>
  // Whether the browser keeps copies of the icons of sites it has been to.
  readonly keepsIcons: boolean
  // The browser's own copy of a page's icon, as an image; '' without one.
  iconOf(pageUrl: string): Promise<string>
  // Whether a page opens in front to have its preview taken.
  readonly previewInFront: boolean
  // A preview of the page in the tab, as a JPEG data address. Throws when the page can't be captured.
  capture(tab: Tab): Promise<string>
  // Shows a note on the captured page, where the page is in front.
  noteOnPage(show: () => Promise<void>): Promise<void>
  // Back to FireDial's tab once the preview is taken.
  backTo(home: Tab | undefined): Promise<void>
  // Asked by the click that starts sync; whether sync may start.
  askSyncAccess(): Promise<boolean>
  // Sync stopped: what only sync needed goes.
  dropSyncAccess(): Promise<void>
  searchEngines(search: SearchApi): Promise<browser.search.SearchEngine[]>
  searchWeb(search: SearchApi, query: string, engine: string | undefined): Promise<void>
  // The name of the extension API in web pages FireDial puts scripts into.
  readonly pageApi: 'browser' | 'chrome'
}
