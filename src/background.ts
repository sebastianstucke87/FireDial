// "Add to FireDial ▸ <view>" in the browser's context menu everywhere: one item for all contexts,
// no URL restriction. Links add the link, everything else the page. A view gives the spark its
// label; Unlabeled adds it without one.
// "New view" adds to a new view, named automatically; rename it in FireDial.
// "Remove from FireDial" deletes sparks with the same link or page. Extensions learn the
// page only with the click, so it's always enabled and the click finds out.
// Also keeps the native bookmarks in sync with the store.

import { IS_CHROME } from './browser.ts'

import * as z from 'zod/mini'

import { parseBackup } from './backup.ts'
import { BookmarkSync, hasBookmarkFolder, samePage } from './bookmarks.ts'
import { GoogleDrive } from './drive.ts'
import { deviceName, forgetToken, googleAuth, revokeAccess, SYNC_DATA } from './google.ts'
import { SiteIcons } from './icons.ts'
import { blobToDataUrl, faviconPath, isStoredImage } from './images.ts'
import { addTo, allocSpark, allocView, isVanilla, newThumbId, nextViewName, SparkId, toLabel, toSparkUrl, ViewId } from './model.ts'
import type { Doc } from './model.ts'
import { browserKeyValue, Store, webLock } from './store.ts'
import { Sync, SyncCommand } from './sync.ts'
import { showToast, toastArgs } from './ui/toast.ts'
import type { Reveal } from './ui/toast.ts'

const ADD_PREFIX = 'add-to-view-'
const NEW_VIEW = 'add-to-new-view'
const REMOVE = 'remove-from-firedial'
const THUMB_WIDTH = 640
const DAY = 86_400_000 // ms
const RevealMessage = z.object({ viewId: ViewId, sparkId: SparkId })

const store = new Store(browserKeyValue, webLock)
// Chrome has no menu on tabs.
const contexts: browser.menus.ContextType[] = IS_CHROME ? ['all'] : ['all', 'tab']

async function buildMenu(): Promise<void> {
  await browser.menus.removeAll()
  await store.load().catch((error: unknown) => {
    console.error('FireDial menu:', error)
  })
  const views = store.doc.views.filter((view) => view.kind !== 'all')
  browser.menus.create({ contexts, id: 'add-root', title: 'Add to FireDial' }) // Browsers allow an extension one entry here, with the manifest's icon
  browser.menus.create({ contexts, id: NEW_VIEW, parentId: 'add-root', title: 'New view' })
  browser.menus.create({ contexts, id: REMOVE, parentId: 'add-root', title: 'Remove from FireDial' })
  browser.menus.create({ contexts, id: 'add-separator', parentId: 'add-root', type: 'separator' })
  for (const view of views) {
    browser.menus.create({ contexts, id: ADD_PREFIX + view.id, parentId: 'add-root', title: view.title })
  }
}

// Builds run one after the other.
let menuBuilt = Promise.resolve()

function rebuildMenu(): void {
  menuBuilt = menuBuilt.then(buildMenu, buildMenu)
}

interface MenuTarget {
  linkUrl?: string | undefined
  pageUrl?: string | undefined
}

const targetUrl = (info: MenuTarget, tab: browser.tabs.Tab | undefined): string => (info.linkUrl || tab?.url || info.pageUrl) ?? ''
const inFireDial = (url: string): boolean => store.doc.sparks.some((spark) => samePage(spark.url, url))

// Pages the browser protects (about:, chrome:, the add-on stores) and background tabs go without.
async function toast(tab: browser.tabs.Tab | undefined, text: string, reveal: Reveal | null = null): Promise<void> {
  if (tab?.id === undefined || !tab.active) return
  await browser.scripting.executeScript({ target: { tabId: tab.id }, func: showToast, args: toastArgs(text, store.doc.prefs, reveal) }).catch(() => undefined)
}

// In a new tab, so the page the spark came from stays. The tab reads the spark to show from storage.
async function revealSpark({ viewId, sparkId }: Reveal, tab: browser.tabs.Tab | undefined): Promise<void> {
  await browserKeyValue.set({ activeView: viewId, reveal: sparkId })
  await browser.tabs.create(tab?.windowId === undefined ? {} : { windowId: tab.windowId })
}

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  if (sender.id !== browser.runtime.id) return
  const reveal = RevealMessage.safeParse(message)
  if (reveal.success) void revealSpark(reveal.data, sender.tab)
})

async function screenshot(tab: browser.tabs.Tab): Promise<string> {
  try {
    const scale = Math.min(1, THUMB_WIDTH / (tab.width ?? THUMB_WIDTH))
    return await browser.tabs.captureVisibleTab(tab.windowId ?? browser.windows.WINDOW_ID_CURRENT, { format: 'jpeg', quality: 85, scale })
  } catch {
    return '' // e.g. pages the browser doesn't allow capturing
  }
}

// The tab's icon as an image of its own. Firefox mostly gives one; Chrome gives the icon's web
// address, so its own copy is taken instead. Nothing from the site itself: none when neither works.
async function tabIcon(tab: browser.tabs.Tab): Promise<string> {
  const given = tab.favIconUrl ?? ''
  if (isStoredImage(given)) return given
  if (!IS_CHROME || !tab.url) return ''
  try {
    const response = await fetch(browser.runtime.getURL(faviconPath(tab.url, 64)))
    return response.ok ? await blobToDataUrl(await response.blob()) : ''
  } catch {
    return ''
  }
}

async function addSpark(info: browser.menus.OnClickData, tab: browser.tabs.Tab | undefined, viewId: ViewId | null): Promise<void> {
  const isLink = Boolean(info.linkUrl)
  const url = toSparkUrl(targetUrl(info, tab))
  if (!url || url.startsWith(browser.runtime.getURL(''))) return
  const title = toLabel((isLink ? info.linkText : tab?.title)?.trim() || url)
  // A screenshot as the preview; the tab's icon as its site's, shown while there is none.
  const shot = !isLink && tab?.active ? await screenshot(tab) : ''
  const icon = !isLink && tab ? await tabIcon(tab) : ''
  const origin = URL.parse(url)?.origin
  if (icon && origin && origin !== 'null') await siteIcons.save([origin], new Map([[origin, icon]]))
  const src = shot
  const thumb = src ? newThumbId() : null

  const added: (Reveal & { name: string })[] = []
  await store.commit(
    (doc: Doc) => {
      const view = (viewId === null ? undefined : doc.views.find((each) => each.id === viewId)) ?? allocView(doc, nextViewName(doc.views))
      const spark = allocSpark(doc, { title, url, thumb })
      addTo([spark], view)
      added.push({ viewId: view.id, sparkId: spark.id, name: view.title })
      return view.id
    },
    thumb ? { thumbs: { [thumb]: src } } : {}
  )
  const [spark] = added
  if (spark) await toast(tab, `Added to ${spark.name}`, { viewId: spark.viewId, sparkId: spark.sparkId })
}

async function removeSpark(info: browser.menus.OnClickData, tab: browser.tabs.Tab | undefined): Promise<void> {
  const url = targetUrl(info, tab)
  await store.load()
  if (!inFireDial(url)) {
    await toast(tab, 'Not in FireDial')
    return
  }
  await store.commit((doc: Doc) => {
    doc.sparks = doc.sparks.filter((spark) => !samePage(spark.url, url))
    return undefined
  })
  await toast(tab, 'Removed from FireDial')
}

browser.menus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId)
  if (id === NEW_VIEW) void addSpark(info, tab, null)
  else if (id === REMOVE) void removeSpark(info, tab)
  else if (id.startsWith(ADD_PREFIX)) void addSpark(info, tab, ViewId.parse(Number(id.slice(ADD_PREFIX.length))))
})

// Images of undone history pile up slowly: once a day is plenty.
async function dailyCleanup(): Promise<void> {
  const { cleanedAt } = await browserKeyValue.get('cleanedAt')
  if (Date.now() - Number(cleanedAt ?? 0) < DAY) return
  await store.load()
  await store.collectGarbage()
  await browserKeyValue.set({ cleanedAt: Date.now() })
}

const sync = new BookmarkSync(store, browserKeyValue, browser.bookmarks)

// Drive sync: changes go up a moment after they're made, so a burst of them goes as one. Newer
// ones come down when a new tab opens or gets focus, at most every PULL_COOLDOWN; Sync now in
// the settings doesn't wait. Without a connection, it tries again every RETRY_DELAY.
const PUSH_DELAY = 2000 // ms
const PULL_COOLDOWN = 30_000 // ms
const RETRY_DELAY = 60_000 // ms
const SyncMessage = z.object({ sync: SyncCommand })
const drive = new GoogleDrive(googleAuth(async () => (await driveSync.state()).email))
const siteIcons = new SiteIcons(browserKeyValue)
const driveSync = new Sync(store, browserKeyValue, drive, Date.now, async (name, content) => drive.upload(name, content, await drive.folder('FireDial')))
let pushTimer: ReturnType<typeof setTimeout> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined

async function syncDrive(pull: boolean): Promise<void> {
  clearTimeout(retryTimer)
  await driveSync.run(pull)
  if ((await driveSync.state()).status === 'offline') retryTimer = setTimeout(() => void syncDrive(true), RETRY_DELAY)
}

async function syncCommand(command: SyncCommand): Promise<void> {
  if (command === 'start') await driveSync.start(await deviceName())
  else if (command === 'drive' || command === 'local') await driveSync.choose(command)
  else if (command === 'now') await syncDrive(true)
  else if (command === 'pull') {
    if (Date.now() - (await driveSync.state()).lastPull >= PULL_COOLDOWN) await syncDrive(true)
  } else {
    await (command === 'stop' ? driveSync.stop() : driveSync.deleteFromDrive())
    if ((await driveSync.state()).on) return
    await (command === 'delete' ? revokeAccess() : forgetToken())
    if (!IS_CHROME) await browser.permissions.remove({ data_collection: SYNC_DATA }).catch(() => false)
  }
}

// Sync commands come only from FireDial's own pages, never from the scripts it puts into web pages.
const fromFireDial = (sender: browser.runtime.MessageSender): boolean =>
  sender.id === browser.runtime.id && Boolean(sender.url?.startsWith(browser.runtime.getURL('')))

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!fromFireDial(sender)) return
  const command = SyncMessage.safeParse(message)
  if (command.success) void syncCommand(command.data.sync)
})

browserKeyValue.onChanged((keys) => {
  if (keys.has('views')) rebuildMenu()
  if (keys.has('rev')) {
    void sync.requestPush()
    clearTimeout(pushTimer)
    pushTimer = setTimeout(() => void syncDrive(false), PUSH_DELAY)
  }
})

browser.bookmarks.onCreated.addListener(() => {
  sync.requestPull()
})
browser.bookmarks.onChanged.addListener(() => {
  sync.requestPull()
})
browser.bookmarks.onMoved.addListener(() => {
  sync.requestPull()
})
browser.bookmarks.onRemoved.addListener(() => {
  sync.requestPull()
})

browser.runtime.onInstalled.addListener(rebuildMenu)
browser.runtime.onStartup.addListener(rebuildMenu)

// Access to sites, asked for by Refresh preview, the bookmark import or an image from a web page,
// lasts until the browser closes: given back when it starts again.
async function dropSiteAccess(): Promise<void> {
  const { origins = [] } = await browser.permissions.getAll()
  if (origins.length) await browser.permissions.remove({ origins }).catch(() => false)
}
browser.runtime.onStartup.addListener(() => void dropSiteAccess())
rebuildMenu()
// A fresh install starts with the sparks in defaults.json. Not when FireDial's bookmarks are
// there already: sync turns those into the sparks instead. Before sync, so it pushes the defaults.
async function seed(): Promise<void> {
  await store.load()
  if (store.revision !== 1 || !isVanilla(store.doc) || (await hasBookmarkFolder(browser.bookmarks))) return
  const response = await fetch(browser.runtime.getURL('defaults.json'))
  await store.replaceAll(parseBackup(await response.json()))
}

void dailyCleanup()
void syncDrive(true)
void seed()
  .catch((error: unknown) => {
    console.error('FireDial defaults:', error)
  })
  .finally(() => {
    void sync.start()
  })
