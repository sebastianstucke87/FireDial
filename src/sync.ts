// Sync through the user's Google Drive: every browser signed in to the same account has the same
// FireDial. Drive holds state.json (the doc and a version that counts up with each change) and
// one file per image, named by its id: images never change, so only missing ones move.
//
// Each browser keeps the doc as it last synced it (the base). A change here is pushed when the
// version on Drive is still the one the base came from; otherwise the newer doc is pulled first
// and the change made here is made again on top of it. A pull lands as one undo step, so it can
// be undone like any change; the undo history itself stays in each browser.

import * as z from 'zod/mini'

import type { Drive, DriveFile } from './drive.ts'
import { OfflineError, SignInError } from './drive.ts'
import { applySide, diff } from './history.ts'
import type { Step } from './history.ts'
import { SparkId, ViewId } from './model.ts'
import type { Doc, ThumbId } from './model.ts'
import { docItems, parseDoc } from './store.ts'
import type { KeyValue, Store } from './store.ts'

const STATE_FILE = 'state.json'
const THUMB_PREFIX = 'thumb-'
const ROUNDS = 5 // pull-then-push rounds before giving up until the next change

// What a FireDial page asks the background for: { sync: command }.
export const SyncCommand = z.enum(['start', 'pull', 'now', 'drive', 'local', 'stop', 'delete'])
export type SyncCommand = z.infer<typeof SyncCommand>

const Stamp = z.object({ device: z.catch(z.string(), ''), at: z.catch(z.number(), 0) })
type Stamp = z.infer<typeof Stamp>

const SyncStateSchema = z.object({
  on: z.catch(z.boolean(), false),
  status: z.catch(z.enum(['off', 'syncing', 'ok', 'offline', 'signin', 'choose']), 'off'),
  email: z.catch(z.string(), ''),
  device: z.catch(z.string(), ''), // this browser, e.g. Firefox on Windows
  version: z.catch(z.number(), 0), // the version on Drive the base came from
  last: z.catch(z.nullable(Stamp), null), // the last change on Drive: which browser, when
  lastPull: z.catch(z.number(), 0),
  // First sync with sparks on both sides: which to keep is up to the user.
  choice: z.catch(z.nullable(z.object({ ...Stamp.shape, sparks: z.catch(z.number(), 0), local: z.catch(z.number(), 0) })), null)
})
export type SyncState = z.infer<typeof SyncStateSchema>

export const parseSyncState = (raw: unknown): SyncState => SyncStateSchema.parse(raw ?? {})

const StoredDoc = z.record(z.string(), z.unknown())
const RemoteSchema = z.object({ version: z.number(), device: z.catch(z.string(), ''), savedAt: z.catch(z.number(), 0), doc: StoredDoc })

interface Remote {
  file: DriveFile
  version: number
  stamp: Stamp
  doc: Doc
}

const content = (doc: Doc): string => JSON.stringify({ views: doc.views, sparks: doc.sparks, prefs: doc.prefs })
const same = (a: Doc, b: Doc): boolean => content(a) === content(b)
const thumbName = (id: ThumbId): string => `${THUMB_PREFIX}${id}`
const thumbsOf = (doc: Doc): Set<ThumbId> => new Set(doc.sparks.flatMap((spark) => spark.thumb ?? []))

type Side = Step['after']

// The change from base to local, made again on the newer remote doc. Sparks and views made here
// may have got ids the remote doc gave to others meanwhile: those get new ones.
export function rebase(base: Doc, local: Doc, remote: Doc): Doc {
  const doc = structuredClone(remote)
  doc.nextSparkId = Math.max(remote.nextSparkId, local.nextSparkId)
  doc.nextViewId = Math.max(remote.nextViewId, local.nextViewId)
  const step = diff(base, local, null, null)
  if (!step) return doc
  const sparkIds = new Map<SparkId, SparkId>()
  const viewIds = new Map<ViewId, ViewId>()
  if (remote.nextSparkId > base.nextSparkId) {
    const known = new Set(base.sparks.map((spark) => spark.id))
    for (const { id } of local.sparks) if (!known.has(id)) sparkIds.set(id, SparkId.parse(doc.nextSparkId++))
  }
  if (remote.nextViewId > base.nextViewId) {
    const known = new Set(base.views.map((view) => view.id))
    for (const { id } of local.views) if (!known.has(id)) viewIds.set(id, ViewId.parse(doc.nextViewId++))
  }
  const side = renumber(step.after, sparkIds, viewIds)
  // Only additions: they go after the remote doc's own, which keeps its order.
  if (keptOrder(base.sparks, local.sparks)) side.sparkOrder = null
  if (keptOrder(base.views, local.views)) side.viewOrder = null
  applySide(doc, side)
  return doc
}

// Whether the items both have are in the same order in both.
function keptOrder(before: readonly { id: number }[], after: readonly { id: number }[]): boolean {
  const kept = new Set(after.map((item) => item.id))
  const known = new Set(before.map((item) => item.id))
  const order = (items: readonly { id: number }[], other: Set<number>): string => JSON.stringify(items.flatMap((item) => (other.has(item.id) ? [item.id] : [])))
  return order(before, kept) === order(after, known)
}

function renumber(side: Side, sparkIds: ReadonlyMap<SparkId, SparkId>, viewIds: ReadonlyMap<ViewId, ViewId>): Side {
  const spark = (id: SparkId): SparkId => sparkIds.get(id) ?? id
  const view = (id: ViewId): ViewId => viewIds.get(id) ?? id
  return {
    sparks: side.sparks.map(({ id, value }) => ({ id: spark(id), value: value && { ...value, id: spark(value.id) } })),
    views: side.views.map(({ id, value }) => ({ id: view(id), value: value && { ...value, id: view(value.id), order: value.order.map(spark) } })),
    sparkOrder: side.sparkOrder?.map(spark) ?? null,
    viewOrder: side.viewOrder?.map(view) ?? null,
    prefs: side.prefs,
    active: side.active === null ? null : view(side.active)
  }
}

// Makes the store's doc this one, as one undo step. Ids never go back: undo may bring back any.
const becomes =
  (target: Doc) =>
  (doc: Doc): undefined => {
    const copy = structuredClone(target)
    doc.views = copy.views
    doc.sparks = copy.sparks
    doc.prefs = copy.prefs
    doc.nextViewId = Math.max(doc.nextViewId, copy.nextViewId)
    doc.nextSparkId = Math.max(doc.nextSparkId, copy.nextSparkId)
    return undefined
  }

export class Sync {
  private readonly store: Store
  private readonly kv: KeyValue
  private readonly drive: Drive
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()

  constructor(store: Store, kv: KeyValue, drive: Drive, now: () => number = Date.now) {
    this.store = store
    this.kv = kv
    this.drive = drive
    this.now = now
  }

  async state(): Promise<SyncState> {
    return parseSyncState((await this.kv.get('sync'))['sync'])
  }

  private async update(changes: Partial<SyncState>): Promise<void> {
    await this.kv.set({ sync: { ...(await this.state()), ...changes } })
  }

  private async base(): Promise<Doc | null> {
    const base = StoredDoc.safeParse((await this.kv.get('syncBase'))['syncBase'])
    return base.success ? parseDoc(base.data) : null
  }

  // One thing at a time; network trouble ends up in the status rather than thrown.
  private serial(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => {
      try {
        await task()
      } catch (error) {
        if (!(await this.state()).on) return
        if (error instanceof SignInError) await this.update({ status: 'signin' })
        else {
          if (!(error instanceof OfflineError)) console.error('FireDial sync:', error)
          await this.update({ status: 'offline' })
        }
      }
    })
    this.queue = run
    return run
  }

  // Turns sync on. Drive empty: this browser's sparks go up. Sparks on both sides: the user picks.
  start(device: string): Promise<void> {
    return this.serial(async () => {
      await this.kv.remove('syncBase')
      await this.kv.set({ sync: { ...parseSyncState({}), on: true, status: 'syncing', device } })
      await this.update({ email: await this.drive.email() })
      const remote = await this.fetchRemote(await this.drive.list())
      if (!remote) return this.cycle(true)
      await this.store.load()
      const local = this.store.doc
      if (local.sparks.length && !same(local, remote.doc)) {
        const choice = { ...remote.stamp, sparks: remote.doc.sparks.length, local: local.sparks.length }
        return this.update({ status: 'choose', choice })
      }
      await this.take(remote)
    })
  }

  // The answer to the first sync's question.
  choose(from: 'drive' | 'local'): Promise<void> {
    return this.serial(async () => {
      const state = await this.state()
      if (state.status !== 'choose') return
      await this.update({ status: 'syncing', choice: null })
      const remote = await this.fetchRemote(await this.drive.list())
      if (from === 'drive' && remote) return this.take(remote)
      // This browser's doc goes over Drive's: no base, and Drive's version as the one known.
      await this.update({ version: remote?.version ?? 0 })
      return this.cycle(true)
    })
  }

  // Sends changes made here; with pull, also checks Drive for newer ones.
  run(pull: boolean): Promise<void> {
    return this.serial(async () => {
      const state = await this.state()
      if (state.on && state.status !== 'choose') await this.cycle(pull)
    })
  }

  stop(): Promise<void> {
    return this.serial(async () => {
      await this.kv.remove('syncBase')
      await this.kv.set({ sync: parseSyncState({}) })
    })
  }

  // Everything FireDial put on Drive goes, and sync stops.
  deleteFromDrive(): Promise<void> {
    return this.serial(async () => {
      for (const file of await this.drive.list()) await this.drive.remove(file.id)
      await this.kv.remove('syncBase')
      await this.kv.set({ sync: parseSyncState({}) })
    })
  }

  private async fetchRemote(files: readonly DriveFile[]): Promise<Remote | null> {
    const file = files.find((each) => each.name === STATE_FILE)
    if (!file) return null
    const data = RemoteSchema.parse(JSON.parse(await this.drive.read(file.id)))
    return { file, version: data.version, stamp: { device: data.device, at: data.savedAt }, doc: parseDoc(data.doc) }
  }

  // The Drive doc becomes this browser's, as it is.
  private async take(remote: Remote): Promise<void> {
    for (let round = 0; round < ROUNDS; round++) {
      await this.store.load()
      if (await this.commit(remote.doc, this.store.revision)) return this.synced(remote)
    }
  }

  private async synced(remote: Remote): Promise<void> {
    await this.kv.set({ syncBase: docItems(remote.doc) })
    await this.update({ status: 'ok', version: remote.version, last: remote.stamp, lastPull: this.now() })
  }

  // false when the store changed meanwhile.
  private async commit(target: Doc, revision: number): Promise<boolean> {
    const have = await this.store.thumbIds()
    const missing = [...thumbsOf(target)].filter((id) => !have.has(id))
    const files = missing.length ? new Map((await this.drive.list()).map((file) => [file.name, file.id])) : new Map<string, string>()
    const thumbs: Record<ThumbId, string> = {}
    for (const id of missing) {
      const file = files.get(thumbName(id))
      if (file) thumbs[id] = await this.drive.read(file) // gone from Drive: the spark goes without
    }
    return this.store.commit(becomes(target), { thumbs, unchecked: true, ifRevision: revision })
  }

  private async cycle(pull: boolean): Promise<void> {
    for (let round = 0; round < ROUNDS; round++) {
      await this.store.load()
      const local = this.store.doc
      const revision = this.store.revision
      const base = await this.base()
      const changed = !base || !same(base, local)
      if (!changed && !pull) return
      const state = await this.state()
      if (state.status !== 'ok') await this.update({ status: 'syncing' })
      const files = await this.drive.list()
      const file = files.find((each) => each.name === STATE_FILE)
      if (file && Number(file.props['version']) !== state.version) {
        const remote = await this.fetchRemote(files)
        if (!remote) continue
        const target = changed && base ? rebase(base, local, remote.doc) : remote.doc
        if (!(await this.commit(target, revision))) continue
        await this.synced(remote)
        pull = false // what's left is pushing what was made again on top
        continue
      }
      if (!changed) return this.update({ status: 'ok', lastPull: this.now() })
      return this.push(local, files, state)
    }
  }

  private async push(local: Doc, files: readonly DriveFile[], state: SyncState): Promise<void> {
    const names = new Map(files.map((file) => [file.name, file.id]))
    const wanted = thumbsOf(local)
    const missing = [...wanted].filter((id) => !names.has(thumbName(id)))
    const images = await this.store.thumbs(missing)
    for (const [id, src] of images) if (src) await this.drive.create(thumbName(id), src)
    const version = state.version + 1
    const stamp = { device: state.device, at: this.now() }
    const body = JSON.stringify({ version, device: stamp.device, savedAt: stamp.at, doc: docItems(local) })
    const props = { version: String(version), device: stamp.device, savedAt: String(stamp.at), sparks: String(local.sparks.length) }
    const file = names.get(STATE_FILE)
    if (file) await this.drive.update(file, body, props)
    else await this.drive.create(STATE_FILE, body, props)
    await this.kv.set({ syncBase: docItems(local) })
    await this.update({ status: 'ok', version, last: stamp, lastPull: this.now() })
    // Images no doc on Drive refers to any more.
    const keep = new Set([...wanted].map(thumbName))
    for (const { name, id } of files) if (name.startsWith(THUMB_PREFIX) && !keep.has(name)) await this.drive.remove(id)
  }
}
