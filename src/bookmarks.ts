// Two-way sync with native bookmarks, for Firefox Sync and bookmark tools: a "FireDial" folder
// in Other Bookmarks, one subfolder per group, one bookmark per spark. Images stay local.
//
// Push makes the bookmarks match the store after a change in FireDial, pull makes the store match
// the bookmarks after a change in Firefox. Both only compare and fix, so running either one again
// changes nothing, and the bookmark events of a push run into a pull that finds nothing to do.
// Pull goes through the store like any change, so even a deletion in Firefox can be undone.
// Push never removes what it doesn't know: only bookmarks and folders it made or adopted.

import * as z from 'zod/mini'

import { allocGroup, allocSpark, canonicalize, GroupId, listOf, SparkId, toLabel, toSparkUrl } from './model.ts'
import type { Doc, Spark } from './model.ts'
import type { KeyValue, Store } from './store.ts'

const ROOT_PARENT = 'unfiled_____' // Other Bookmarks
const ROOT_TITLE = 'FireDial'
const SAVE_EVERY = 50 // bookmark writes between saving the map, so a crash can't orphan many
const PULL_DELAY = 300 // ms: Firefox Sync and bulk edits fire many events in a row

export interface TreeNode {
  id: string
  title: string
  type?: string | undefined
  url?: string | null | undefined
  children?: TreeNode[] | undefined
}

export interface BookmarkApi {
  getChildren(id: string): Promise<TreeNode[]>
  getSubTree(id: string): Promise<TreeNode[]>
  create(details: { parentId: string; title: string; url?: string }): Promise<{ id: string }>
  update(id: string, changes: { title?: string; url?: string }): Promise<unknown>
  move(id: string, destination: { parentId: string; index: number }): Promise<unknown>
  remove(id: string): Promise<void>
  removeTree(id: string): Promise<void>
}

interface BookmarkMap {
  root: string | null
  groups: Map<GroupId, string>
  sparks: Map<SparkId, string>
}

const emptyMap = (): BookmarkMap => ({ root: null, groups: new Map(), sparks: new Map() })

const entries = <S extends z.ZodMiniType>(key: S) => z.catch(listOf(z.tuple([key, z.string()])), [])
const MapSchema = z.object({ root: z.catch(z.nullable(z.string()), null), groups: entries(GroupId), sparks: entries(SparkId) })

export function parseMap(raw: unknown): BookmarkMap {
  const result = MapSchema.safeParse(raw)
  if (!result.success) return emptyMap()
  const { root, groups, sparks } = result.data
  return { root, groups: new Map(groups), sparks: new Map(sparks) }
}

const serializeMap = (map: BookmarkMap): Record<string, unknown> => ({ root: map.root, groups: [...map.groups], sparks: [...map.sparks] })

const isFolder = (node: TreeNode): boolean => node.type === 'folder'
const isBookmark = (node: TreeNode): boolean => node.type === 'bookmark'
const childFolders = (node: TreeNode): TreeNode[] => (node.children ?? []).filter(isFolder)
const childBookmarks = (node: TreeNode): TreeNode[] => (node.children ?? []).filter(isBookmark)

// Firefox stores URLs normalized: https://a.example becomes https://a.example/.
function canonicalUrl(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

const sameUrl = (a: string, b: string): boolean => canonicalUrl(a) === canonicalUrl(b)

// What's left of an address once a site's redirects don't matter: to https, to or from www.
function pageOf(url: string): string {
  try {
    const { protocol, hostname, port, pathname, search, hash } = new URL(url)
    return `${/^https?:$/.test(protocol) ? '' : protocol}//${hostname.replace(/^www\./, '')}:${port}${pathname}${search}${hash}`
  } catch {
    return url
  }
}

export const samePage = (a: string, b: string): boolean => pageOf(a) === pageOf(b)

function reversed<Id>(map: ReadonlyMap<Id, string>): Map<string, Id> {
  return new Map([...map].map(([id, bookmarkId]) => [bookmarkId, id]))
}

// Puts the ranked items in rank order, in the places ranked items hold; the others stay put.
function sortRanked<Item extends { id: number }>(items: readonly Item[], rank: ReadonlyMap<number, number>): Item[] {
  const ranked = items.filter((item) => rank.has(item.id)).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
  let next = 0
  return items.map((item) => (rank.has(item.id) ? (ranked[next++] ?? item) : item))
}

// Pull: the doc takes over the tree. New folders and bookmarks become groups and sparks, what's
// gone from the tree goes from the doc. Sparks a push couldn't map stay. A bookmark directly in
// the root folder joins the first group.
function applyTree(doc: Doc, root: TreeNode, map: BookmarkMap): void {
  const groupIds = reversed(map.groups)
  const sparkIds = reversed(map.sparks)
  const groups = new Map(doc.groups.map((group) => [group.id, group]))
  const sparks = new Map(doc.sparks.map((spark) => [spark.id, spark]))
  const seenGroups = new Set<GroupId>()
  const seenSparks = new Set<SparkId>()
  const position = new Map<number, number>()

  const place = (node: TreeNode, groupId: GroupId): void => {
    const known = sparkIds.get(node.id)
    const spark = known === undefined ? undefined : sparks.get(known)
    if (spark) seenSparks.add(spark.id)
    const url = toSparkUrl(node.url ?? '')
    if (!url) return
    const target: Spark = spark ?? allocSpark(doc, { groupId, title: toLabel(node.title), url, thumb: null })
    map.sparks.set(target.id, node.id)
    seenSparks.add(target.id)
    target.title = toLabel(node.title)
    target.groupId = groupId
    if (!sameUrl(target.url, url)) target.url = url
    position.set(target.id, position.size)
  }

  for (const folder of childFolders(root)) {
    const known = groupIds.get(folder.id)
    const group = (known === undefined ? undefined : groups.get(known)) ?? allocGroup(doc, toLabel(folder.title))
    group.title = toLabel(folder.title)
    map.groups.set(group.id, folder.id)
    seenGroups.add(group.id)
    for (const node of childBookmarks(folder)) place(node, group.id)
  }
  const first = childFolders(root)[0] ? [...seenGroups][0] : doc.groups[0]?.id
  if (first !== undefined) {
    for (const node of childBookmarks(root)) place(node, first)
  }

  for (const id of map.groups.keys()) {
    if (!seenGroups.has(id)) map.groups.delete(id)
  }
  for (const id of map.sparks.keys()) {
    if (!seenSparks.has(id)) map.sparks.delete(id)
  }
  const mappedGroups = new Set(groupIds.values())
  const mappedSparks = new Set(sparkIds.values())
  doc.groups = doc.groups.filter((group) => seenGroups.has(group.id) || !mappedGroups.has(group.id))
  doc.sparks = doc.sparks.filter((spark) => seenSparks.has(spark.id) || !mappedSparks.has(spark.id))

  doc.groups = sortRanked(doc.groups, new Map([...seenGroups].map((id, index) => [id, index])))
  canonicalize(doc)
  doc.sparks = sortRanked(doc.sparks, position)
  canonicalize(doc)
}

async function fetchRoot(api: BookmarkApi, id: string): Promise<TreeNode | null> {
  try {
    return (await api.getSubTree(id))[0] ?? null
  } catch {
    return null // deleted
  }
}

// FireDial's folder is in the bookmarks already, e.g. brought by Firefox Sync from another device.
export async function hasBookmarkFolder(api: BookmarkApi): Promise<boolean> {
  return (await api.getChildren(ROOT_PARENT)).some((node) => isFolder(node) && node.title === ROOT_TITLE)
}

// The root folder. It comes back if it's gone: deleting it must not wipe FireDial.
async function ensureRoot(api: BookmarkApi, map: BookmarkMap): Promise<TreeNode> {
  const current = map.root === null ? null : await fetchRoot(api, map.root)
  if (current) return current
  map.groups.clear()
  map.sparks.clear()
  const existing = (await api.getChildren(ROOT_PARENT)).find((node) => isFolder(node) && node.title === ROOT_TITLE)
  const id = existing?.id ?? (await api.create({ parentId: ROOT_PARENT, title: ROOT_TITLE })).id
  map.root = id
  const root = await fetchRoot(api, id)
  if (!root) throw new Error('Bookmark folder vanished')
  return root
}

class Pusher {
  private readonly api: BookmarkApi
  private readonly map: BookmarkMap
  private readonly save: () => Promise<void>
  private writes = 0

  constructor(api: BookmarkApi, map: BookmarkMap, save: () => Promise<void>) {
    this.api = api
    this.map = map
    this.save = save
  }

  // One failed bookmark must not stop the rest: the spark just stays local until the next push.
  private async attempt<T>(write: () => Promise<T>): Promise<T | null> {
    try {
      const result = await write()
      if (++this.writes % SAVE_EVERY === 0) await this.save()
      return result
    } catch (error) {
      console.warn('FireDial bookmark sync:', error)
      return null
    }
  }

  private async pushGroups(doc: Doc, root: TreeNode): Promise<Map<GroupId, TreeNode | null>> {
    const folders = new Map(childFolders(root).map((node) => [node.id, node]))
    const taken = new Set(this.map.groups.values())
    const result = new Map<GroupId, TreeNode | null>()
    for (const group of doc.groups) {
      const mapped = this.map.groups.get(group.id)
      const existing = mapped === undefined ? undefined : folders.get(mapped)
      // A folder nobody claims with this name: an interrupted first sync, or a reinstall.
      const folder = existing ?? childFolders(root).find((node) => node.title === group.title && !taken.has(node.id))
      if (folder) {
        taken.add(folder.id)
        this.map.groups.set(group.id, folder.id)
        result.set(group.id, folder)
        if (folder.title !== group.title) await this.attempt(() => this.api.update(folder.id, { title: group.title }))
        continue
      }
      const created = await this.attempt(() => this.api.create({ parentId: root.id, title: group.title }))
      if (created) {
        this.map.groups.set(group.id, created.id)
        result.set(group.id, { id: created.id, title: group.title, type: 'folder', children: [] })
      }
    }
    return result
  }

  private async pushSparks(doc: Doc, root: TreeNode, folders: ReadonlyMap<GroupId, TreeNode | null>): Promise<void> {
    const bookmarks = new Map(
      childFolders(root)
        .flatMap(childBookmarks)
        .concat(childBookmarks(root))
        .map((node) => [node.id, node])
    )
    const taken = new Set(this.map.sparks.values())
    for (const spark of doc.sparks) {
      const folder = folders.get(spark.groupId)
      if (!folder) continue
      const mapped = this.map.sparks.get(spark.id)
      const existing = mapped === undefined ? undefined : bookmarks.get(mapped)
      const node = existing ?? childBookmarks(folder).find((item) => sameUrl(item.url ?? '', spark.url) && !taken.has(item.id))
      if (!node) {
        const created = await this.attempt(() => this.api.create({ parentId: folder.id, title: spark.title, url: spark.url }))
        if (created) this.map.sparks.set(spark.id, created.id)
        continue
      }
      taken.add(node.id)
      this.map.sparks.set(spark.id, node.id)
      if (node.title !== spark.title || !sameUrl(node.url ?? '', spark.url)) {
        await this.attempt(() => this.api.update(node.id, { title: spark.title, url: spark.url }))
      }
    }
  }

  private async removeStale(doc: Doc, root: TreeNode): Promise<void> {
    const sparkIds = new Set(doc.sparks.map((spark) => spark.id))
    const groupIds = new Set(doc.groups.map((group) => group.id))
    const present = new Set(
      childFolders(root)
        .flatMap(childBookmarks)
        .concat(childBookmarks(root))
        .map((node) => node.id)
    )
    const folders = new Set(childFolders(root).map((node) => node.id))
    for (const [id, bookmarkId] of this.map.sparks) {
      if (sparkIds.has(id)) continue
      this.map.sparks.delete(id)
      if (present.has(bookmarkId)) await this.attempt(() => this.api.remove(bookmarkId))
    }
    for (const [id, folderId] of this.map.groups) {
      if (groupIds.has(id)) continue
      this.map.groups.delete(id)
      if (folders.has(folderId)) await this.attempt(() => this.api.removeTree(folderId))
    }
  }

  private async order(parentId: string, children: readonly TreeNode[], wanted: readonly (string | undefined)[]): Promise<void> {
    const current = children.map((node) => node.id)
    let index = 0
    for (const id of wanted) {
      if (id === undefined) continue
      const from = current.indexOf(id)
      if (from < 0) continue
      if (from !== index) {
        await this.attempt(() => this.api.move(id, { parentId, index }))
        current.splice(from, 1)
        current.splice(index, 0, id)
      }
      index += 1
    }
  }

  // Moves into the right folder first, then puts everything in order, from a fresh look at the tree.
  private async arrange(doc: Doc, rootId: string): Promise<void> {
    const root = await fetchRoot(this.api, rootId)
    if (!root) return
    const parentOf = new Map(childFolders(root).flatMap((folder) => childBookmarks(folder).map((node) => [node.id, folder.id])))
    for (const node of childBookmarks(root)) parentOf.set(node.id, root.id)
    let moved = false
    for (const spark of doc.sparks) {
      const id = this.map.sparks.get(spark.id)
      const folderId = this.map.groups.get(spark.groupId)
      if (id === undefined || folderId === undefined || parentOf.get(id) === folderId) continue
      await this.attempt(() => this.api.move(id, { parentId: folderId, index: 0 }))
      moved = true
    }
    const fresh = moved ? await fetchRoot(this.api, rootId) : root
    if (!fresh) return
    await this.order(
      fresh.id,
      fresh.children ?? [],
      doc.groups.map((group) => this.map.groups.get(group.id))
    )
    for (const group of doc.groups) {
      const folderId = this.map.groups.get(group.id)
      const folder = childFolders(fresh).find((node) => node.id === folderId)
      if (!folder) continue
      const ids = doc.sparks.filter((spark) => spark.groupId === group.id).map((spark) => this.map.sparks.get(spark.id))
      await this.order(folder.id, folder.children ?? [], ids)
    }
  }

  async push(doc: Doc): Promise<void> {
    await this.removeStale(doc, await ensureRoot(this.api, this.map))
    const root = await ensureRoot(this.api, this.map) // what's left: nothing removed may be adopted
    const folders = await this.pushGroups(doc, root)
    await this.pushSparks(doc, root, folders)
    await this.arrange(doc, root.id)
  }
}

// Runs in the background script, one job at a time. A job asked for while one runs waits for it.
export class BookmarkSync {
  private readonly store: Store
  private readonly kv: KeyValue
  private readonly api: BookmarkApi
  private running = false
  private wantPush = false
  private wantPull = false
  private pullTimer: ReturnType<typeof setTimeout> | undefined

  constructor(store: Store, kv: KeyValue, api: BookmarkApi) {
    this.store = store
    this.kv = kv
    this.api = api
  }

  requestPush(): Promise<void> {
    this.wantPush = true
    return this.pump()
  }

  requestPull(): void {
    clearTimeout(this.pullTimer)
    this.pullTimer = setTimeout(() => {
      this.wantPull = true
      void this.pump()
    }, PULL_DELAY)
  }

  // At startup: unsynced changes in FireDial first, then whatever happened to the bookmarks.
  start(): Promise<void> {
    this.wantPush = true
    this.wantPull = true
    return this.pump()
  }

  // Resolves once nothing is left to do, or at once when another call is already at it.
  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.wantPush || this.wantPull) {
        if (this.wantPush) {
          this.wantPush = false
          await this.push()
        } else {
          this.wantPull = false
          await this.pull()
        }
      }
    } catch (error) {
      console.error('FireDial bookmark sync:', error)
    } finally {
      this.running = false
    }
  }

  private async readSyncState(): Promise<{ map: BookmarkMap; syncedRev: number }> {
    const { bookmarkMap, syncedRev } = await this.kv.get(['bookmarkMap', 'syncedRev'])
    return { map: parseMap(bookmarkMap), syncedRev: Number(syncedRev) || 0 }
  }

  private async push(): Promise<void> {
    await this.store.load()
    const { map, syncedRev } = await this.readSyncState()
    const { doc, revision } = this.store
    if (revision === syncedRev && map.root !== null) return
    const save = (): Promise<void> => this.kv.set({ bookmarkMap: serializeMap(map) })
    await new Pusher(this.api, map, save).push(doc)
    await this.kv.set({ bookmarkMap: serializeMap(map), syncedRev: revision })
  }

  private async pull(): Promise<void> {
    await this.store.load()
    const { map, syncedRev } = await this.readSyncState()
    if (this.store.revision !== syncedRev) {
      this.wantPush = true
      this.wantPull = true
      return
    }
    const root = map.root === null ? null : await fetchRoot(this.api, map.root)
    if (!root) {
      map.root = null // gone: push puts it back
      await this.kv.set({ bookmarkMap: serializeMap(map) })
      this.wantPush = true
      return
    }
    const applied = await this.store.commit(
      (doc) => {
        applyTree(doc, root, map)
        return undefined
      },
      { unchecked: true, ifRevision: syncedRev }
    )
    if (!applied) {
      this.wantPush = true
      this.wantPull = true
      return
    }
    const loose = childBookmarks(root).length > 0
    await this.kv.set({ bookmarkMap: serializeMap(map), syncedRev: loose ? syncedRev : this.store.revision })
    if (loose) this.wantPush = true // into their group's folder
  }
}
