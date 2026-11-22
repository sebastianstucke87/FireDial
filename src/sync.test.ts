import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as z from 'zod/mini'

import type { Drive, DriveFile } from './drive.ts'
import { OfflineError, SignInError } from './drive.ts'
import { allocSpark, allocView, emptyDoc, LabelName, newThumbId, SparkId, SparkUrl, toLabel } from './model.ts'
import type { Doc } from './model.ts'
import { backupName } from './backup.ts'
import { Store, thumbKey } from './store.ts'
import type { KeyValue, Lock } from './store.ts'
import { parseSyncState, rebase, Sync, SyncCommand } from './sync.ts'
import type { Keep } from './sync.ts'

function memory(): KeyValue & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get(keys) {
      const list = [keys].flat()
      return Promise.resolve(Object.fromEntries(list.filter((key) => data.has(key)).map((key) => [key, structuredClone(data.get(key))])))
    },
    set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value))
      return Promise.resolve()
    },
    remove(keys) {
      for (const key of [keys].flat()) data.delete(key)
      return Promise.resolve()
    },
    onChanged() {}
  }
}

function queue(): Lock {
  let tail: Promise<unknown> = Promise.resolve()
  return (task) => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}

class FakeDrive implements Drive {
  files = new Map<string, { name: string; content: string; props: Record<string, string> }>()
  creates: string[] = []
  failure: Error | null = null
  private next = 0

  private check(): void {
    if (this.failure) throw this.failure
  }

  list(): Promise<DriveFile[]> {
    this.check()
    return Promise.resolve([...this.files].map(([id, { name, props }]) => ({ id, name, props: { ...props } })))
  }

  read(id: string): Promise<string> {
    this.check()
    return Promise.resolve(this.files.get(id)?.content ?? '')
  }

  create(name: string, content: string, props: Record<string, string> = {}): Promise<DriveFile> {
    this.check()
    const id = `f${this.next++}`
    this.files.set(id, { name, content, props })
    this.creates.push(name)
    return Promise.resolve({ id, name, props })
  }

  update(id: string, content: string, props: Record<string, string> = {}): Promise<void> {
    this.check()
    const file = this.files.get(id)
    if (file) this.files.set(id, { ...file, content, props })
    return Promise.resolve()
  }

  async remove(ids: readonly string[], progress?: (done: number) => Promise<void>): Promise<void> {
    this.check()
    for (const id of ids) this.files.delete(id)
    await progress?.(ids.length)
  }

  email(): Promise<string> {
    return Promise.resolve('me@example.com')
  }

  names(): string[] {
    return [...this.files.values()].map((file) => file.name).sort()
  }
}

interface Browser {
  kv: ReturnType<typeof memory>
  store: Store
  sync: Sync
}

async function browserWith(drive: Drive, keep?: Keep): Promise<Browser> {
  const kv = memory()
  const store = new Store(kv, queue())
  await store.load()
  const sync = new Sync(store, kv, drive, () => 1000, keep)
  return { kv, store, sync }
}

const titles = (store: Store): string[] => store.doc.sparks.map((spark) => spark.title)

const add = (store: Store, title: string, src = ''): Promise<boolean> => {
  const thumb = src ? newThumbId() : null
  return store.commit(
    (doc) => {
      allocSpark(doc, { title: toLabel(title), url: SparkUrl.parse(`https://${title}.example/`), thumb })
      return undefined
    },
    thumb ? { thumbs: { [thumb]: src } } : {}
  )
}

async function synced(drive: FakeDrive, ...sparks: string[]): Promise<Browser> {
  const browser = await browserWith(drive)
  for (const title of sparks) await add(browser.store, title)
  await browser.sync.start('Firefox on Windows')
  return browser
}

test('first sync with an empty Drive uploads this browser', async () => {
  const drive = new FakeDrive()
  const a = await browserWith(drive)
  await add(a.store, 'a', 'data:image/png;base64,AAAA')
  await a.sync.start('Firefox on Windows')
  assert.deepEqual(
    drive.names().map((name) => name.replace(/^thumb-.*/, 'thumb')),
    ['state.json', 'thumb']
  )
  const state = await a.sync.state()
  assert.equal(state.email, 'me@example.com')
  assert.equal(state.status, 'ok')
  assert.equal(state.version, 1)
  assert.deepEqual(state.last, { device: 'Firefox on Windows', at: 1000 })
})

test('a preview on Drive that is no image is left out', async () => {
  const drive = new FakeDrive()
  const a = await browserWith(drive)
  await add(a.store, 'a', 'data:image/png;base64,AAAA')
  await a.sync.start('Firefox on Windows')
  for (const file of drive.files.values()) if (file.name.startsWith('thumb-')) file.content = 'data:text/html,<p>'
  const b = await browserWith(drive)
  await b.sync.start('Chrome on Windows')
  assert.deepEqual(titles(b.store), ['a'])
  const thumb = b.store.doc.sparks[0]?.thumb
  assert.ok(thumb)
  assert.equal(b.kv.data.get(thumbKey(thumb)), undefined)
})

test('a browser without sparks takes Drive as it is, images too', async () => {
  const drive = new FakeDrive()
  const a = await browserWith(drive)
  await add(a.store, 'a', 'data:image/png;base64,AAAA')
  await a.sync.start('Firefox on Windows')
  const b = await browserWith(drive)
  await b.sync.start('Chrome on Windows')
  assert.deepEqual(titles(b.store), ['a'])
  const thumb = b.store.doc.sparks[0]?.thumb
  assert.ok(thumb)
  assert.equal(b.kv.data.get(thumbKey(thumb)), 'data:image/png;base64,AAAA')
  assert.equal((await b.sync.state()).status, 'ok')
})

test('a pulled change is one undo step', async () => {
  const drive = new FakeDrive()
  const a = await synced(drive, 'a')
  const b = await synced(drive)
  await add(a.store, 'x')
  await add(a.store, 'y')
  await a.sync.run(false)
  await b.sync.run(true)
  assert.deepEqual(titles(b.store), ['a', 'x', 'y'])
  await b.store.undo()
  assert.deepEqual(titles(b.store), ['a'])
})

test('without pull, nothing unchanged goes to Drive', async () => {
  const drive = new FakeDrive()
  const a = await synced(drive, 'a')
  const before = drive.creates.length
  drive.failure = new OfflineError('no')
  await a.sync.run(false)
  drive.failure = null
  assert.equal(drive.creates.length, before)
  assert.equal((await a.sync.state()).status, 'ok')
})

test('a held-up change is made again on top of the newer one', async () => {
  const drive = new FakeDrive()
  const a = await synced(drive, 'a')
  const b = await synced(drive)
  await add(a.store, 'x')
  await a.sync.run(false)
  await add(b.store, 'y') // b hasn't seen x: both got the same id
  await b.sync.run(false)
  assert.deepEqual(titles(b.store), ['a', 'x', 'y'])
  const ids = b.store.doc.sparks.map((spark) => spark.id)
  assert.equal(new Set(ids).size, ids.length)
  await a.sync.run(true)
  assert.deepEqual(titles(a.store), ['a', 'x', 'y'])
  assert.equal((await a.sync.state()).version, (await b.sync.state()).version)
})

test('a held-up deletion stays deleted', async () => {
  const drive = new FakeDrive()
  const a = await synced(drive, 'a', 'b')
  const b = await synced(drive)
  await add(a.store, 'x')
  await a.sync.run(false)
  await b.store.commit((doc) => {
    doc.sparks = doc.sparks.filter((spark) => spark.title !== 'a')
    return undefined
  })
  await b.sync.run(false)
  assert.deepEqual(titles(b.store), ['b', 'x'])
})

test('only missing images move', async () => {
  const drive = new FakeDrive()
  const a = await browserWith(drive)
  await add(a.store, 'a', 'data:image/png;base64,AAAA')
  await a.sync.start('Firefox on Windows')
  await add(a.store, 'b', 'data:image/png;base64,BBBB')
  drive.creates = []
  await a.sync.run(false)
  assert.equal(drive.creates.filter((name) => name.startsWith('thumb-')).length, 1)
})

test('images nothing refers to any more leave Drive', async () => {
  const drive = new FakeDrive()
  const a = await browserWith(drive)
  await add(a.store, 'a', 'data:image/png;base64,AAAA')
  await a.sync.start('Firefox on Windows')
  await a.store.commit((doc) => {
    doc.sparks = []
    return undefined
  })
  await a.sync.run(false)
  assert.deepEqual(drive.names(), ['state.json'])
})

test('sparks on both sides: the user picks Drive', async () => {
  const drive = new FakeDrive()
  await synced(drive, 'a')
  const b = await browserWith(drive)
  await add(b.store, 'mine')
  await b.sync.start('Chrome on Windows')
  const state = await b.sync.state()
  assert.equal(state.status, 'choose')
  assert.deepEqual(state.choice, { device: 'Firefox on Windows', at: 1000, sparks: 1, local: 1 })
  await b.sync.choose('drive')
  assert.deepEqual(titles(b.store), ['a'])
  await b.store.undo()
  assert.deepEqual(titles(b.store), ['mine'])
})

test('sparks on both sides: the user picks this browser', async () => {
  const drive = new FakeDrive()
  const a = await synced(drive, 'a')
  const b = await browserWith(drive)
  await add(b.store, 'mine')
  await b.sync.start('Chrome on Windows')
  await b.sync.choose('local')
  assert.deepEqual(titles(b.store), ['mine'])
  await a.sync.run(true)
  assert.deepEqual(titles(a.store), ['mine'])
})

// A Keep that remembers each backup's name and its sparks' titles and previews.
function kept(): { keep: Keep; files: { name: string; sparks: { title: string; thumb: string }[] }[] } {
  const files: { name: string; sparks: { title: string; thumb: string }[] }[] = []
  const keep: Keep = async (name, content) => {
    const { sparks } = z.object({ sparks: z.array(z.object({ title: z.string(), thumb: z.string() })) }).parse(JSON.parse(await content.text()))
    files.push({ name, sparks })
  }
  return { keep, files }
}

test('the side the choice replaces is kept as a backup first, previews too', async () => {
  const drive = new FakeDrive()
  await synced(drive, 'a')
  const first = await browserWith(drive)
  await add(first.store, 'theirs', 'data:image/png;base64,AAAA')
  await first.sync.start('Firefox on Windows')
  await first.sync.choose('local')
  const picksDrive = kept()
  const b = await browserWith(drive, picksDrive.keep)
  await add(b.store, 'mine', 'data:image/png;base64,BBBB')
  await b.sync.start('Chrome on Windows')
  await b.sync.choose('drive')
  assert.deepEqual(picksDrive.files, [{ name: backupName(new Date(1000), true), sparks: [{ title: 'mine', thumb: 'data:image/png;base64,BBBB' }] }])
  const picksLocal = kept()
  const c = await browserWith(drive, picksLocal.keep)
  await add(c.store, 'other')
  await c.sync.start('Chrome on Windows')
  await c.sync.choose('local')
  assert.deepEqual(picksLocal.files[0]?.sparks, [{ title: 'theirs', thumb: 'data:image/png;base64,AAAA' }])
  assert.deepEqual(titles(c.store), ['other'])
})

test('without a backup, the choice replaces nothing and sync stops', async () => {
  const drive = new FakeDrive()
  await synced(drive, 'a')
  const b = await browserWith(drive, () => Promise.reject(new Error('quota')))
  await add(b.store, 'mine')
  await b.sync.start('Chrome on Windows')
  await b.sync.choose('drive')
  assert.deepEqual(titles(b.store), ['mine'])
  const state = await b.sync.state()
  assert.equal(state.on, false)
  assert.equal(state.problem, 'Sync not started: the backup failed')
  await b.sync.run(true)
  assert.deepEqual(titles(b.store), ['mine'])
  assert.equal(b.kv.data.has('syncBase'), false)
})

test('no connection or an expired sign-in shows in the status', async () => {
  const drive = new FakeDrive()
  const a = await synced(drive, 'a')
  await add(a.store, 'b')
  drive.failure = new OfflineError('no')
  await a.sync.run(false)
  assert.equal((await a.sync.state()).status, 'offline')
  drive.failure = new SignInError('no')
  await a.sync.run(true)
  assert.equal((await a.sync.state()).status, 'signin')
  drive.failure = null
  await a.sync.run(false)
  assert.equal((await a.sync.state()).status, 'ok')
})

test('stop keeps everything; Delete from Drive empties it', async () => {
  const drive = new FakeDrive()
  const a = await synced(drive, 'a')
  await a.sync.stop()
  assert.equal((await a.sync.state()).on, false)
  assert.deepEqual(titles(a.store), ['a'])
  assert.deepEqual(drive.names(), ['state.json'])
  await a.sync.start('Firefox on Windows')
  await a.sync.deleteFromDrive()
  assert.deepEqual(drive.names(), [])
  assert.equal((await a.sync.state()).on, false)
})

test('rebase gives new ids to sparks made on both sides', () => {
  const base: Doc = emptyDoc()
  const local = structuredClone(base)
  const remote = structuredClone(base)
  const url = SparkUrl.parse('https://a.example/')
  allocSpark(local, { title: toLabel('mine'), url, thumb: null })
  allocSpark(remote, { title: toLabel('theirs'), url, thumb: newThumbId() })
  const doc = rebase(base, local, remote)
  assert.deepEqual(
    doc.sparks.map((spark) => [spark.id, spark.title]),
    [
      [0, 'theirs'],
      [1, 'mine']
    ]
  )
  assert.equal(doc.nextSparkId, 2)
})

test('many previews: how far it is, while they move', async () => {
  const drive = new FakeDrive()
  const a = await browserWith(drive)
  for (let index = 0; index < 12; index++) await add(a.store, `s${index}`, `data:image/png;base64,${index}`)
  const seen: unknown[] = []
  const set = a.kv.set.bind(a.kv)
  a.kv.set = (items) => {
    if ('syncProgress' in items) seen.push(items['syncProgress'])
    return set(items)
  }
  await a.sync.start('Firefox on Windows')
  assert.deepEqual(seen[0], { done: 0, total: 12 })
  assert.deepEqual(seen.at(-1), { done: 12, total: 12 })
  assert.equal(a.kv.data.has('syncProgress'), false)
})

test('undo after a pull with a change of its own takes back what came in', async () => {
  const drive = new FakeDrive()
  const chrome = await synced(drive, 'a')
  const firefox = await synced(drive)
  await add(chrome.store, 'mozilla')
  await chrome.sync.run(false)
  await add(firefox.store, 'github')
  await firefox.sync.run(true)
  assert.deepEqual(titles(firefox.store), ['a', 'mozilla', 'github'])
  await firefox.store.undo()
  assert.deepEqual(titles(firefox.store), ['a', 'github'])
  await firefox.sync.run(false)
  await chrome.sync.run(true)
  assert.deepEqual(titles(chrome.store), ['a', 'github'])
})

test('re-importing the same images moves no previews, an image on several sparks neither', async () => {
  const drive = new FakeDrive()
  const a = await browserWith(drive)
  for (let index = 0; index < 12; index++) await add(a.store, `s${index}`, `data:image/png;base64,${index % 6}`)
  await a.sync.start('Firefox on Windows')
  const b = await browserWith(drive)
  await b.sync.start('Chrome on Windows')
  const images = await a.store.thumbs(a.store.doc.sparks.flatMap((spark) => spark.thumb ?? []))
  const sparks = a.store.doc.sparks.map((spark, key) => ({
    key,
    title: spark.title,
    url: spark.url,
    src: spark.thumb ? (images.get(spark.thumb) ?? '') : '',
    labels: []
  }))
  await a.store.replaceAll({ views: [], sparks, prefs: a.store.doc.prefs })
  drive.creates = []
  await a.sync.run(false)
  assert.equal(drive.creates.filter((name) => name.startsWith('thumb-')).length, 0, 'nothing uploaded')
  const read = drive.read.bind(drive)
  let reads = 0
  drive.read = (id) => {
    reads++
    return read(id)
  }
  await b.sync.run(true)
  assert.equal(reads, 1, 'only state.json')
})

// Every sync state and progress written, in order.
function written(browser: Browser, key: 'sync' | 'syncProgress'): unknown[] {
  const seen: unknown[] = []
  const set = browser.kv.set.bind(browser.kv)
  browser.kv.set = (items) => {
    if (key in items) seen.push(structuredClone(items[key]))
    return set(items)
  }
  return seen
}
const statuses = (seen: unknown[]): unknown[] => seen.map((state) => parseSyncState(state).status)

test('what a page may ask the background', () => {
  assert.deepEqual(SyncCommand.options, ['start', 'pull', 'now', 'drive', 'local', 'stop', 'delete'])
})

test('a sync state from nothing, or from something broken, is off', () => {
  const off = { on: false, status: 'off', email: '', device: '', version: 0, last: null, lastPull: 0, problem: '', choice: null }
  assert.deepEqual(parseSyncState(undefined), off)
  assert.deepEqual(parseSyncState({ on: 1, status: 'x', email: 2, device: 3, version: 'a', last: 4, lastPull: 'b', problem: 5, choice: 6 }), off)
  for (const status of ['off', 'syncing', 'ok', 'offline', 'signin', 'choose']) assert.equal(parseSyncState({ status }).status, status)
  assert.deepEqual(parseSyncState({ last: { device: 5 } }).last, { device: '', at: 0 })
})

test('a Drive doc without its device still syncs', async () => {
  const drive = new FakeDrive()
  await synced(drive, 'a')
  const [id, file] = [...drive.files].find(([, each]) => each.name === 'state.json') ?? assert.fail('no state')
  drive.files.set(id, { ...file, content: file.content.replace(/"device":"[^"]*",/, '') })
  const b = await synced(drive)
  assert.deepEqual(titles(b.store), ['a'])
  assert.deepEqual((await b.sync.state()).last, { device: '', at: 1000 })
})

test('no previews: Drive isn’t asked which there are', async () => {
  const drive = new FakeDrive()
  await synced(drive, 'a')
  let lists = 0
  const list = drive.list.bind(drive)
  drive.list = () => {
    lists += 1
    return list()
  }
  await synced(drive)
  assert.equal(lists, 1)
})

test('rebase of nothing changed here: the remote doc, with ids never going back', () => {
  const base = emptyDoc()
  const local = structuredClone(base)
  allocSpark(local, { title: toLabel('gone'), url: SparkUrl.parse('https://a.example/'), thumb: null })
  allocView(local, 'Gone')
  local.sparks = []
  local.views = local.views.slice(0, 2)
  const remote = structuredClone(base)
  remote.prefs.columns = 7
  const doc = rebase(base, base, remote)
  assert.deepEqual(doc, remote)
  const kept = rebase(local, local, remote)
  assert.equal(kept.nextSparkId, 1)
  assert.equal(kept.nextViewId, 3)
  assert.equal(kept.prefs.columns, 7)
})

test('rebase keeps the ids made here when the remote doc made none', () => {
  const base = emptyDoc()
  const local = structuredClone(base)
  allocSpark(local, { title: toLabel('mine'), url: SparkUrl.parse('https://a.example/'), thumb: null })
  allocView(local, 'Mine')
  const remote = structuredClone(base)
  remote.prefs.columns = 7
  const doc = rebase(base, local, remote)
  assert.deepEqual(
    doc.sparks.map((spark) => [spark.id, spark.title]),
    [[0, 'mine']]
  )
  assert.deepEqual(
    doc.views.map((view) => [view.id, view.title]),
    [
      [0, 'All'],
      [1, 'Unlabeled'],
      [2, 'Mine']
    ]
  )
  assert.equal(doc.nextSparkId, 1)
  assert.equal(doc.nextViewId, 3)
  assert.equal(doc.prefs.columns, 7)
})

test('rebase: only what’s new here gets a new id, a change to something known keeps its own', () => {
  const url = SparkUrl.parse('https://a.example/')
  const base = emptyDoc()
  allocSpark(base, { title: toLabel('old'), url, thumb: null })
  allocView(base, 'Old')
  const local = structuredClone(base)
  const old = local.sparks[0] ?? assert.fail('no spark')
  old.title = toLabel('edited')
  allocSpark(local, { title: toLabel('mine'), url, thumb: null })
  const mineView = allocView(local, 'Mine')
  mineView.order = [SparkId.parse(1)]
  const oldView = local.views.find((view) => view.title === 'Old') ?? assert.fail('no view')
  oldView.title = LabelName.parse('Older')
  const remote = structuredClone(base)
  allocSpark(remote, { title: toLabel('theirs'), url, thumb: null })
  allocView(remote, 'Theirs')
  const doc = rebase(base, local, remote)
  assert.deepEqual(
    doc.sparks.map((spark) => [spark.id, spark.title]),
    [
      [0, 'edited'],
      [1, 'theirs'],
      [2, 'mine']
    ]
  )
  assert.deepEqual(
    doc.views.map((view) => [view.id, view.title]),
    [
      [0, 'All'],
      [1, 'Unlabeled'],
      [2, 'Older'],
      [3, 'Theirs'],
      [4, 'Mine']
    ]
  )
  assert.equal(doc.nextSparkId, 3)
  assert.equal(doc.nextViewId, 5)
})

test('rebase: a new order made here wins, otherwise the remote one stays', () => {
  const url = SparkUrl.parse('https://a.example/')
  const base = emptyDoc()
  for (const title of ['a', 'b']) allocSpark(base, { title: toLabel(title), url, thumb: null })
  for (const title of ['X', 'Y']) allocView(base, title)
  const remote = structuredClone(base)
  remote.sparks.reverse()
  remote.views = [...remote.views.slice(0, 2), ...remote.views.slice(2).reverse()]
  const added = structuredClone(base)
  allocSpark(added, { title: toLabel('c'), url, thumb: null })
  allocView(added, 'Z')
  const kept = rebase(base, added, remote)
  assert.deepEqual(
    kept.sparks.map((spark) => spark.title),
    ['b', 'a', 'c']
  )
  assert.deepEqual(
    kept.views.map((view) => view.title),
    ['All', 'Unlabeled', 'Y', 'X', 'Z']
  )
  const moved = structuredClone(base)
  moved.sparks.reverse()
  moved.views = [...moved.views.slice(0, 2), ...moved.views.slice(2).reverse()]
  const remoteChanged = structuredClone(base)
  remoteChanged.prefs.columns = 7
  const mine = rebase(base, moved, remoteChanged)
  assert.deepEqual(
    mine.sparks.map((spark) => spark.title),
    ['b', 'a']
  )
  assert.deepEqual(
    mine.views.map((view) => view.title),
    ['All', 'Unlabeled', 'Y', 'X']
  )
})

test('taking a doc keeps the higher ids of this browser', async () => {
  const drive = new FakeDrive()
  await synced(drive, 'a')
  const b = await browserWith(drive)
  await b.store.commit((doc) => {
    allocView(doc, 'Kept')
    return undefined
  })
  await b.sync.start('Chrome on Windows')
  assert.deepEqual(titles(b.store), ['a'])
  assert.equal(b.store.doc.nextViewId, 3)
})

test('trouble while sync is off leaves the status alone', async () => {
  const drive = new FakeDrive()
  const a = await browserWith(drive)
  drive.failure = new OfflineError('no')
  await a.sync.deleteFromDrive()
  assert.deepEqual(await a.sync.state(), parseSyncState(undefined))
})

test('trouble: offline warns with its cause, anything else is an error', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined)
  const error = t.mock.method(console, 'error', () => undefined)
  const drive = new FakeDrive()
  const a = await synced(drive, 'a')
  await add(a.store, 'b')
  drive.failure = new OfflineError('no', { cause: new TypeError('NetworkError') })
  await a.sync.run(false)
  assert.equal((await a.sync.state()).problem, 'TypeError: NetworkError')
  assert.equal(warn.mock.callCount(), 1)
  assert.equal(warn.mock.calls[0]?.arguments[0], 'FireDial sync:')
  assert.equal(error.mock.callCount(), 0)
  drive.failure = new OfflineError('busy')
  await a.sync.run(false)
  assert.equal((await a.sync.state()).problem, 'Error: busy')
  drive.failure = new Error('broken')
  await a.sync.run(false)
  const state = await a.sync.state()
  assert.equal(state.status, 'offline')
  assert.equal(state.problem, 'Error: broken')
  assert.equal(error.mock.callCount(), 1)
  assert.equal(error.mock.calls[0]?.arguments[0], 'FireDial sync:')
  assert.equal(warn.mock.callCount(), 2)
})

test('start begins afresh: no old base, syncing until done', async () => {
  const drive = new FakeDrive()
  await synced(drive, 'a')
  const b = await browserWith(drive)
  await add(b.store, 'mine')
  await b.kv.set({ syncBase: { sparks: [] } })
  const seen = written(b, 'sync')
  await b.sync.start('Chrome on Windows')
  assert.equal(b.kv.data.has('syncBase'), false)
  assert.deepEqual(statuses(seen), ['syncing', 'syncing', 'choose'])
})

test('the answer to a question nobody asked does nothing', async () => {
  const drive = new FakeDrive()
  const a = await synced(drive, 'a')
  const seen = written(a, 'sync')
  await a.sync.choose('local')
  assert.deepEqual(seen, [])
})

test('the answer clears the question, even with Drive emptied meanwhile', async () => {
  const drive = new FakeDrive()
  await synced(drive, 'a')
  const b = await browserWith(drive)
  await add(b.store, 'mine')
  await b.sync.start('Chrome on Windows')
  const seen = written(b, 'sync')
  drive.files.clear()
  await b.sync.choose('local')
  assert.deepEqual(statuses(seen).slice(0, 1), ['syncing'])
  assert.equal(parseSyncState(seen[0]).choice, null)
  const state = await b.sync.state()
  assert.equal(state.status, 'ok')
  assert.equal(state.version, 1)
  assert.equal(state.choice, null)
  assert.deepEqual(drive.names(), ['state.json'])
})

test('nothing runs while sync is off or waits for the answer', async () => {
  const drive = new FakeDrive()
  const off = await browserWith(drive)
  await add(off.store, 'a')
  await off.sync.run(true)
  assert.deepEqual(drive.names(), [])
  await synced(drive, 'x')
  const b = await browserWith(drive)
  await add(b.store, 'mine')
  await b.sync.start('Chrome on Windows')
  const before = [...drive.files.values()].map((file) => file.content)
  await b.sync.run(true)
  assert.deepEqual(
    [...drive.files.values()].map((file) => file.content),
    before
  )
  assert.equal((await b.sync.state()).status, 'choose')
})

test('stop forgets the base', async () => {
  const drive = new FakeDrive()
  const a = await synced(drive, 'a')
  assert.equal(a.kv.data.has('syncBase'), true)
  await a.sync.stop()
  assert.equal(a.kv.data.has('syncBase'), false)
})

test('Delete from Drive shows how far it is from the start, and stops showing it even when it fails', async () => {
  const drive = new FakeDrive()
  const a = await synced(drive, 'a', 'b')
  await add(a.store, 'c', 'data:image/png;base64,AAAA')
  await a.sync.run(false)
  const seen = written(a, 'syncProgress')
  await a.sync.deleteFromDrive()
  assert.deepEqual(seen, [
    { done: 0, total: 0, deleting: true },
    { done: 2, total: 2, deleting: true }
  ])
  assert.equal(a.kv.data.has('syncProgress'), false)
  assert.equal(a.kv.data.has('syncBase'), false)
  const b = await synced(drive, 'x')
  const remove = drive.remove.bind(drive)
  drive.remove = () => Promise.reject(new OfflineError('no'))
  await b.sync.deleteFromDrive()
  drive.remove = remove
  assert.equal(b.kv.data.has('syncProgress'), false)
  assert.equal(b.kv.data.has('syncBase'), true)
  assert.equal((await b.sync.state()).status, 'offline')
})

test('a few previews move without showing how far; ten do', async () => {
  for (const [count, shown] of [
    [9, false],
    [10, true]
  ] as const) {
    const drive = new FakeDrive()
    const a = await browserWith(drive)
    for (let index = 0; index < count; index++) await add(a.store, `s${index}`, `data:image/png;base64,${index}`)
    const seen = written(a, 'syncProgress')
    await a.sync.start('Firefox on Windows')
    assert.equal(seen.length > 0, shown)
  }
})

test('previews moving fast: how far it is shows at most every quarter second', async () => {
  const drive = new FakeDrive()
  const a = await browserWith(drive)
  for (let index = 0; index < 12; index++) await add(a.store, `s${index}`, `data:image/png;base64,${index}`)
  const seen = written(a, 'syncProgress')
  await a.sync.start('Firefox on Windows')
  assert.deepEqual(seen, [
    { done: 0, total: 12 },
    { done: 12, total: 12 }
  ])
  let now = 0
  const b = await browserWith(drive)
  const slow = new Sync(b.store, b.kv, drive, () => (now += 100))
  const shown = written(b, 'syncProgress')
  await slow.start('Chrome on Windows')
  const done = shown.map((progress) => z.object({ done: z.number() }).parse(progress).done)
  assert.equal(done[0], 0)
  assert.equal(done.at(-1), 12)
  assert.ok(done.length > 2 && done.length < 13, `shown ${done.join()}`)
})

test('a preview gone from Drive: the spark comes without it', async () => {
  const drive = new FakeDrive()
  const a = await browserWith(drive)
  for (let index = 0; index < 2; index++) await add(a.store, `s${index}`, `data:image/png;base64,${index}`)
  await a.sync.start('Firefox on Windows')
  for (const [id, file] of drive.files) if (file.name.startsWith('thumb-')) drive.files.delete(id)
  const b = await browserWith(drive)
  await b.sync.start('Chrome on Windows')
  assert.deepEqual(titles(b.store), ['s0', 's1'])
  assert.equal((await b.store.thumbIds()).size, 0)
})

test('after trouble, a run shows syncing again; when all is well it doesn’t', async () => {
  const drive = new FakeDrive()
  const a = await synced(drive, 'a')
  const quiet = written(a, 'sync')
  await a.sync.run(true)
  assert.deepEqual(statuses(quiet), ['ok'])
  await add(a.store, 'b')
  drive.failure = new OfflineError('no')
  await a.sync.run(false)
  drive.failure = null
  quiet.length = 0
  await a.sync.run(true)
  assert.deepEqual(statuses(quiet).slice(0, 1), ['syncing'])
  assert.equal((await a.sync.state()).status, 'ok')
})

test('a pull without news says when it looked', async () => {
  const drive = new FakeDrive()
  let now = 1000
  const a = await browserWith(drive)
  await add(a.store, 'a')
  const sync = new Sync(a.store, a.kv, drive, () => now)
  await sync.start('Firefox on Windows')
  now = 5000
  await sync.run(true)
  const state = await sync.state()
  assert.equal(state.lastPull, 5000)
  assert.equal(state.status, 'ok')
})

test('previews still in use stay on Drive', async () => {
  const drive = new FakeDrive()
  const a = await browserWith(drive)
  await add(a.store, 'a', 'data:image/png;base64,AAAA')
  await a.sync.start('Firefox on Windows')
  await add(a.store, 'b')
  await a.sync.run(false)
  assert.equal(drive.names().filter((name) => name.startsWith('thumb-')).length, 1)
})

test('icons sync: one browser’s icons reach another, and icons found there come back', async () => {
  const drive = new FakeDrive()
  const icon = 'data:image/png;base64,AAAA'
  const a = await browserWith(drive)
  await add(a.store, 'a')
  await add(a.store, 'b')
  await a.kv.set({ 'icon:https://a.example': { src: icon, at: 1 } })
  await a.sync.start('Firefox on Windows')
  assert.ok(drive.names().includes('icons.json'))
  const b = await browserWith(drive)
  await b.sync.start('Chrome on Windows')
  assert.deepEqual(b.kv.data.get('icon:https://a.example'), { src: icon, at: 1000 })
  await b.kv.set({ 'icon:https://b.example': { src: icon, at: 1 } })
  await b.sync.run(true)
  await a.sync.run(true)
  assert.deepEqual(a.kv.data.get('icon:https://b.example'), { src: icon, at: 1000 })
  assert.deepEqual(a.kv.data.get('icon:https://a.example'), { src: icon, at: 1 }) // its own stays
})
