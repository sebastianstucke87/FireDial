// "Add to FireDial ▸ <group>" in Firefox's context menu everywhere: one item for all contexts,
// no URL restriction. Links add the link, everything else the page.
// "New Group" adds to a new group, named automatically; rename it in FireDial.
// "Remove from FireDial" takes the same link or page out of every group. Extensions learn the
// page only with the click, so it's always enabled and the click finds out.
// Also keeps the native bookmarks in sync with the store.

import * as z from 'zod/mini'

import { parseBackup } from './backup.ts'
import { BookmarkSync, hasBookmarkFolder, samePage } from './bookmarks.ts'
import { allocGroup, allocSpark, emptyDoc, GroupId, isVanilla, newThumbId, nextGroupName, SparkId, toLabel, toSparkUrl } from './model.ts'
import type { Doc } from './model.ts'
import { browserKeyValue, Store, webLock } from './store.ts'
import { showToast, toastArgs } from './ui/toast.ts'
import type { Reveal } from './ui/toast.ts'

const ADD_PREFIX = 'add-to-group-'
const NEW_GROUP = 'add-to-new-group'
const REMOVE = 'remove-from-firedial'
const THUMB_WIDTH = 640
const DAY = 86_400_000 // ms
const RevealMessage = z.object({ groupId: GroupId, sparkId: SparkId })

const store = new Store(browserKeyValue, webLock)
const contexts: browser.menus.ContextType[] = ['all', 'tab']

async function buildMenu(): Promise<void> {
  await browser.menus.removeAll()
  await store.load().catch((error: unknown) => {
    console.error('FireDial menu:', error)
  })
  const groups = store.doc.groups.length ? store.doc.groups : emptyDoc().groups
  browser.menus.create({ contexts, id: 'add-root', title: 'Add to FireDial' }) // Firefox allows an extension one entry here, always with the manifest's icon
  browser.menus.create({ contexts, id: NEW_GROUP, parentId: 'add-root', title: 'New Group' })
  browser.menus.create({ contexts, id: REMOVE, parentId: 'add-root', title: 'Remove from FireDial' })
  browser.menus.create({ contexts, id: 'add-separator', parentId: 'add-root', type: 'separator' })
  for (const group of groups) {
    browser.menus.create({ contexts, id: ADD_PREFIX + group.id, parentId: 'add-root', title: group.title })
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

// Pages Firefox protects (about:, addons.mozilla.org) and background tabs go without.
async function toast(tab: browser.tabs.Tab | undefined, text: string, reveal: Reveal | null = null): Promise<void> {
  if (tab?.id === undefined || !tab.active) return
  await browser.scripting.executeScript({ target: { tabId: tab.id }, func: showToast, args: toastArgs(text, store.doc.prefs, reveal) }).catch(() => undefined)
}

// In a new tab, so the page the spark came from stays. The tab reads the spark to show from storage.
async function revealSpark({ groupId, sparkId }: Reveal, tab: browser.tabs.Tab | undefined): Promise<void> {
  await browserKeyValue.set({ activeGroup: groupId, reveal: sparkId })
  await browser.tabs.create(tab?.windowId === undefined ? {} : { windowId: tab.windowId })
}

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  const reveal = RevealMessage.safeParse(message)
  if (reveal.success) void revealSpark(reveal.data, sender.tab)
})

async function screenshot(tab: browser.tabs.Tab): Promise<string> {
  try {
    const scale = Math.min(1, THUMB_WIDTH / (tab.width ?? THUMB_WIDTH))
    return await browser.tabs.captureVisibleTab(tab.windowId ?? browser.windows.WINDOW_ID_CURRENT, { format: 'jpeg', quality: 85, scale })
  } catch {
    return '' // e.g. pages Firefox doesn't allow capturing
  }
}

async function addSpark(info: browser.menus.OnClickData, tab: browser.tabs.Tab | undefined, groupId: GroupId | null): Promise<void> {
  const isLink = Boolean(info.linkUrl)
  const url = toSparkUrl(targetUrl(info, tab))
  if (!url || url.startsWith('moz-extension:')) return
  const title = toLabel((isLink ? info.linkText : tab?.title)?.trim() || url)
  // A screenshot; the tab's icon only when there is none.
  const shot = !isLink && tab?.active ? await screenshot(tab) : ''
  const icon = !isLink && !shot ? (tab?.favIconUrl ?? '') : ''
  const src = shot || icon
  const thumb = src ? newThumbId() : null

  const added: (Reveal & { name: string })[] = []
  await store.commit(
    (doc: Doc) => {
      const target = groupId ?? allocGroup(doc, nextGroupName(doc.groups)).id
      const spark = allocSpark(doc, { groupId: target, title, url, thumb })
      added.push({ groupId: target, sparkId: spark.id, name: doc.groups.find((group) => group.id === target)?.title ?? '' })
      return target
    },
    thumb ? { thumbs: { [thumb]: src } } : {}
  )
  const [spark] = added
  if (spark) await toast(tab, `Added to ${spark.name}`, { groupId: spark.groupId, sparkId: spark.sparkId })
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
  if (id === NEW_GROUP) void addSpark(info, tab, null)
  else if (id === REMOVE) void removeSpark(info, tab)
  else if (id.startsWith(ADD_PREFIX)) void addSpark(info, tab, GroupId.parse(Number(id.slice(ADD_PREFIX.length))))
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

browserKeyValue.onChanged((keys) => {
  if (keys.has('groups')) rebuildMenu()
  if (keys.has('rev')) void sync.requestPush()
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
void seed()
  .catch((error: unknown) => {
    console.error('FireDial defaults:', error)
  })
  .finally(() => {
    void sync.start()
  })
