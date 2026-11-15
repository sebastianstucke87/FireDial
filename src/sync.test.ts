import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Drive, DriveFile } from './drive.ts'
import { OfflineError, SignInError } from './drive.ts'
import { allocSpark, emptyDoc, newThumbId, SparkUrl, toLabel } from './model.ts'
import type { Doc } from './model.ts'
import { Store, thumbKey } from './store.ts'
import type { KeyValue, Lock } from './store.ts'
import { rebase, Sync } from './sync.ts'

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

  remove(id: string): Promise<void> {
    this.check()
    this.files.delete(id)
    return Promise.resolve()
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

async function browserWith(drive: Drive): Promise<Browser> {
  const kv = memory()
  const store = new Store(kv, queue())
  await store.load()
  const sync = new Sync(store, kv, drive, () => 1000)
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
