import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BookmarkSync, hasBookmarkFolder, parseMap, samePage } from './bookmarks.ts'
import type { BookmarkApi, TreeNode } from './bookmarks.ts'
import { allocGroup, allocSpark, LIMITS, SparkUrl, toLabel } from './model.ts'
import type { Doc, GroupId, Spark } from './model.ts'
import { Store } from './store.ts'
import type { KeyValue, Lock } from './store.ts'

// Firefox's bookmarks as far as FireDial cares: normalized URLs, stable ids, failures on bad URLs.
class FakeBookmarks implements BookmarkApi {
  private nextId = 1
  writes = 0
  readonly root: TreeNode = { id: 'unfiled_____', title: 'Other Bookmarks', type: 'folder', children: [] }

  private find(id: string, node: TreeNode = this.root): TreeNode | null {
    if (node.id === id) return node
    for (const child of node.children ?? []) {
      const found = this.find(id, child)
      if (found) return found
    }
    return null
  }

  private parentOf(id: string, node: TreeNode = this.root): TreeNode | null {
    if (node.children?.some((child) => child.id === id)) return node
    for (const child of node.children ?? []) {
      const found = this.parentOf(id, child)
      if (found) return found
    }
    return null
  }

  private detach(id: string): TreeNode {
    const parent = this.parentOf(id)
    const index = parent?.children?.findIndex((child) => child.id === id) ?? -1
    const removed = parent?.children?.splice(index, 1)[0]
    if (!removed) throw new Error(`No bookmark ${id}`)
    return removed
  }

  getChildren(id: string): Promise<TreeNode[]> {
    return Promise.resolve(structuredClone(this.find(id)?.children ?? []))
  }

  getSubTree(id: string): Promise<TreeNode[]> {
    const node = this.find(id)
    if (!node) return Promise.reject(new Error('node is null'))
    return Promise.resolve([structuredClone(node)])
  }

  create(details: { parentId: string; title: string; url?: string }): Promise<{ id: string }> {
    this.writes += 1
    if (details.url === 'bad' || details.title === 'refused') return Promise.reject(new Error('Invalid bookmark'))
    const node: TreeNode =
      details.url === undefined
        ? { id: `b${this.nextId++}`, title: details.title, type: 'folder', url: null, children: [] }
        : { id: `b${this.nextId++}`, title: details.title, type: 'bookmark', url: new URL(details.url).href }
    this.find(details.parentId)?.children?.push(node)
    return Promise.resolve({ id: node.id })
  }

  update(id: string, changes: { title?: string; url?: string }): Promise<unknown> {
    this.writes += 1
    const node = this.find(id)
    if (!node) return Promise.reject(new Error('gone'))
    if (changes.title !== undefined) node.title = changes.title
    if (changes.url !== undefined) node.url = new URL(changes.url).href
    return Promise.resolve(null)
  }

  move(id: string, destination: { parentId: string; index: number }): Promise<unknown> {
    this.writes += 1
    const node = this.detach(id)
    this.find(destination.parentId)?.children?.splice(destination.index, 0, node)
    return Promise.resolve(null)
  }

  remove(id: string): Promise<void> {
    this.writes += 1
    this.detach(id)
    return Promise.resolve()
  }

  removeTree(id: string): Promise<void> {
    return this.remove(id)
  }

  // Edits made in Firefox, without going through FireDial's own counter.
  folder(): TreeNode {
    const folder = this.root.children?.find((node) => node.title === 'FireDial')
    assert.ok(folder)
    return folder
  }

  child(title: string, node: TreeNode = this.folder()): TreeNode {
    const found = node.children?.find((item) => item.title === title)
    assert.ok(found, `no ${title}`)
    return found
  }

  shape(): unknown {
    return (this.folder().children ?? []).map((folder) => [folder.title, (folder.children ?? []).map((node) => node.title)])
  }
}

function memory(): KeyValue & { data: Map<string, unknown>; sets: string[][] } {
  const data = new Map<string, unknown>()
  const sets: string[][] = []
  return {
    data,
    sets,
    get(keys) {
      const list = [keys].flat()
      return Promise.resolve(Object.fromEntries(list.filter((key) => data.has(key)).map((key) => [key, structuredClone(data.get(key))])))
    },
    set(items) {
      sets.push(Object.keys(items).sort())
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value))
      return Promise.resolve()
    },
    remove(keys) {
      for (const key of [keys].flat()) data.delete(key)
      return Promise.resolve()
    },
    onChanged() {
      // the tests run sync jobs themselves
    }
  }
}

const noLock: Lock = (task) => task()

interface Setup {
  kv: ReturnType<typeof memory>
  store: Store
  api: FakeBookmarks
  sync: BookmarkSync
  // Two sync rounds with everything settled: the first lets a pull see the push's result.
  settle: () => Promise<void>
}

async function setup(): Promise<Setup> {
  const kv = memory()
  const store = new Store(kv, noLock)
  const api = new FakeBookmarks()
  const sync = new BookmarkSync(store, kv, api)
  await store.load()
  return { kv, store, api, sync, settle: () => sync.start() }
}

function spark(doc: Doc, title: string, groupId?: GroupId): Spark {
  const target = groupId ?? doc.groups[0]?.id
  if (target === undefined) throw new Error('no group')
  return allocSpark(doc, { groupId: target, title: toLabel(title), url: SparkUrl.parse(`https://${title}.example`), thumb: null })
}

async function seeded(): Promise<Setup> {
  const context = await setup()
  await context.store.commit((doc) => {
    spark(doc, 'a')
    spark(doc, 'b')
    const linux = allocGroup(doc, toLabel('Linux'))
    spark(doc, 'c', linux.id)
    return undefined
  })
  await context.settle()
  return context
}

const titles = (store: Store): string[] => store.doc.sparks.map((item) => item.title)

test("FireDial's folder counts only as a folder named FireDial in Other Bookmarks", async () => {
  const api = new FakeBookmarks()
  assert.equal(await hasBookmarkFolder(api), false)
  await api.create({ parentId: 'unfiled_____', title: 'FireDial', url: 'https://example.com/' })
  await api.create({ parentId: 'unfiled_____', title: 'Other' })
  assert.equal(await hasBookmarkFolder(api), false)
  await api.create({ parentId: 'unfiled_____', title: 'FireDial' })
  assert.equal(await hasBookmarkFolder(api), true)
})

test('first push builds the folder tree', async () => {
  const { api } = await seeded()
  assert.deepEqual(api.shape(), [
    ['Home', ['a', 'b']],
    ['Linux', ['c']]
  ])
})

test('a synced state causes no writes, even with normalized URLs', async () => {
  const { store, api, settle } = await seeded()
  const steps = store.canUndo
  const writes = api.writes
  await settle()
  await settle()
  assert.equal(api.writes, writes)
  assert.equal(store.canUndo, steps)
  await store.undo() // only the seeding step exists: first sync added none
  assert.equal(store.canUndo, false)
})

test('changes in FireDial reach the bookmarks', async () => {
  const { store, api, settle } = await seeded()
  await store.commit((doc) => {
    const [first] = doc.sparks
    if (first) first.title = toLabel('renamed')
    doc.sparks = doc.sparks.filter((item) => item.title !== 'b')
    const group = doc.groups[1]
    if (group) group.title = toLabel('Penguins')
    return undefined
  })
  await settle()
  assert.deepEqual(api.shape(), [
    ['Home', ['renamed']],
    ['Penguins', ['c']]
  ])
})

test('moving and reordering in FireDial reaches the bookmarks', async () => {
  const { store, api, settle } = await seeded()
  await store.commit((doc) => {
    doc.sparks.reverse()
    doc.groups.reverse()
    return undefined
  })
  await settle()
  assert.deepEqual(api.shape(), [
    ['Linux', ['c']],
    ['Home', ['b', 'a']]
  ])
  const linux = store.doc.groups[0]
  await store.commit((doc) => {
    const target = doc.sparks.find((item) => item.title === 'a')
    if (target && linux) target.groupId = linux.id
    return undefined
  })
  await settle()
  assert.deepEqual(api.shape(), [
    ['Linux', ['c', 'a']],
    ['Home', ['b']]
  ])
})

test('removing a group removes its folder', async () => {
  const { store, api, settle } = await seeded()
  await store.commit((doc) => {
    doc.groups = doc.groups.filter((group) => group.title !== 'Linux')
    doc.sparks = doc.sparks.filter((item) => item.title !== 'c')
    return undefined
  })
  await settle()
  assert.deepEqual(api.shape(), [['Home', ['a', 'b']]])
})

test('edits in Firefox reach FireDial', async () => {
  const { store, api, settle } = await seeded()
  const home = api.child('Home')
  await api.update(api.child('a', home).id, { title: 'A!', url: 'https://other.example/' })
  await api.update(api.child('Linux').id, { title: 'Penguins' })
  await settle()
  assert.deepEqual(titles(store), ['A!', 'b', 'c'])
  assert.equal(store.doc.sparks[0]?.url, 'https://other.example/')
  assert.equal(store.doc.groups[1]?.title, 'Penguins')
})

test('new bookmarks and folders in Firefox become sparks and groups', async () => {
  const { store, api, settle } = await seeded()
  const made = await api.create({ parentId: api.folder().id, title: 'Work' })
  await api.create({ parentId: made.id, title: 'mail', url: 'https://mail.example/' })
  await api.create({ parentId: api.child('Home').id, title: 'd', url: 'https://d.example/' })
  await settle()
  assert.deepEqual(
    store.doc.groups.map((group) => group.title),
    ['Home', 'Linux', 'Work']
  )
  assert.deepEqual(titles(store), ['a', 'b', 'd', 'c', 'mail'])
})

test('moves and reorders in Firefox reach FireDial', async () => {
  const { store, api, settle } = await seeded()
  const home = api.child('Home')
  await api.move(api.child('b', home).id, { parentId: home.id, index: 0 })
  await api.move(api.child('c', api.child('Linux')).id, { parentId: home.id, index: 1 })
  await api.move(api.child('Linux').id, { parentId: api.folder().id, index: 0 })
  await settle()
  assert.deepEqual(
    store.doc.groups.map((group) => group.title),
    ['Linux', 'Home']
  )
  assert.deepEqual(titles(store), ['b', 'c', 'a'])
})

test('a deletion in Firefox can be undone, and the bookmark comes back', async () => {
  const { store, api, settle } = await seeded()
  await api.remove(api.child('a', api.child('Home')).id)
  await settle()
  assert.deepEqual(titles(store), ['b', 'c'])
  await store.undo()
  assert.deepEqual(titles(store), ['a', 'b', 'c'])
  await settle()
  assert.deepEqual(api.shape(), [
    ['Home', ['a', 'b']],
    ['Linux', ['c']]
  ])
})

test('deleting a group folder in Firefox removes group and sparks', async () => {
  const { store, api, settle } = await seeded()
  await api.removeTree(api.child('Linux').id)
  await settle()
  assert.deepEqual(
    store.doc.groups.map((group) => group.title),
    ['Home']
  )
  assert.deepEqual(titles(store), ['a', 'b'])
})

test('undoing a removal in FireDial makes a new bookmark', async () => {
  const { store, api, settle } = await seeded()
  await store.commit((doc) => {
    doc.sparks = doc.sparks.filter((item) => item.title !== 'a')
    return undefined
  })
  await settle()
  assert.deepEqual(api.shape(), [
    ['Home', ['b']],
    ['Linux', ['c']]
  ])
  await store.undo()
  await settle()
  assert.deepEqual(api.shape(), [
    ['Home', ['a', 'b']],
    ['Linux', ['c']]
  ])
})

test('deleting the whole FireDial folder wipes nothing: it comes back', async () => {
  const { store, api, settle } = await seeded()
  await api.removeTree(api.folder().id)
  await settle()
  assert.deepEqual(titles(store), ['a', 'b', 'c'])
  assert.deepEqual(api.shape(), [
    ['Home', ['a', 'b']],
    ['Linux', ['c']]
  ])
})

test('a bookmark directly in the FireDial folder joins the first group', async () => {
  const { store, api, settle } = await seeded()
  await api.create({ parentId: api.folder().id, title: 'loose', url: 'https://loose.example/' })
  await settle()
  await settle()
  assert.deepEqual(titles(store), ['a', 'b', 'loose', 'c'])
  assert.deepEqual(api.shape(), [
    ['Home', ['a', 'b', 'loose']],
    ['Linux', ['c']]
  ])
})

test('an import with the same group names replaces the bookmarks cleanly', async () => {
  const { store, api, settle } = await seeded()
  await store.replaceAll({
    groups: [{ key: 1, title: toLabel('Home') }],
    sparks: [{ groupKey: 1, title: toLabel('new'), url: SparkUrl.parse('https://new.example/'), src: '' }],
    prefs: store.doc.prefs
  })
  await settle()
  assert.deepEqual(api.shape(), [['Home', ['new']]])
  assert.deepEqual(titles(store), ['new'])
})

test('a spark the bookmark API refuses stays in FireDial, the rest syncs', async () => {
  const { store, api, settle } = await setup()
  await store.commit((doc) => {
    spark(doc, 'a')
    allocSpark(doc, { groupId: doc.groups[0]?.id ?? allocGroup(doc, toLabel('x')).id, title: toLabel('refused'), url: SparkUrl.parse('bad'), thumb: null })
    spark(doc, 'b')
    return undefined
  })
  await settle()
  await settle()
  assert.deepEqual(titles(store), ['a', 'refused', 'b'])
  assert.deepEqual(api.shape(), [['Home', ['a', 'b']]])
})

test('an interrupted first sync adopts what it made instead of doubling it', async () => {
  const first = await seeded()
  const kv = memory()
  const store = new Store(kv, noLock)
  await store.load()
  await store.commit((doc) => {
    spark(doc, 'a')
    spark(doc, 'b')
    const linux = allocGroup(doc, toLabel('Linux'))
    spark(doc, 'c', linux.id)
    return undefined
  })
  await new BookmarkSync(store, kv, first.api).start() // same bookmarks, no map
  assert.deepEqual(first.api.shape(), [
    ['Home', ['a', 'b']],
    ['Linux', ['c']]
  ])
})

test('a fresh install picks up an existing FireDial folder', async () => {
  const { api } = await seeded()
  const kv = memory()
  const store = new Store(kv, noLock)
  await store.load()
  await new BookmarkSync(store, kv, api).start()
  assert.deepEqual(
    store.doc.groups.map((group) => group.title),
    ['Home', 'Linux']
  )
  assert.deepEqual(titles(store), ['a', 'b', 'c'])
})

test('unknown items in the folder survive a push', async () => {
  const { store, api, settle } = await seeded()
  const home = api.child('Home')
  home.children?.push({ id: 'sep', title: '', type: 'separator' })
  await store.commit((doc) => {
    spark(doc, 'd')
    return undefined
  })
  await settle()
  assert.ok(api.child('Home').children?.some((node) => node.id === 'sep'))
})

test('the map survives storage', () => {
  const map = parseMap({
    root: 'r',
    groups: [[1, 'g']],
    sparks: [
      [2, 's'],
      ['bad', 's']
    ]
  })
  assert.equal(map.root, 'r')
  assert.equal(map.sparks.size, 1)
  assert.equal(parseMap(null).root, null)
})

test('a page counts as the same one after a redirect to www or https', () => {
  assert.equal(samePage('http://example.com/a?b=1', 'https://www.example.com/a?b=1'), true)
  assert.equal(samePage('https://www.example.com/', 'https://example.com'), true)
  assert.equal(samePage('https://example.com/a', 'https://example.com/b'), false)
  assert.equal(samePage('https://example.com:8080/', 'https://example.com/'), false)
  assert.equal(samePage('https://sub.example.com/', 'https://example.com/'), false)
  assert.equal(samePage('ftp://example.com/', 'https://example.com/'), false)
})

test('a page is only the same one after a redirect, not with any www or http in it', () => {
  assert.equal(samePage('https://a.www.example.com/', 'https://a.example.com/'), false)
  assert.equal(samePage('git+https://example.com/', 'https://example.com/'), false)
  assert.equal(samePage('https+x://example.com/', 'https://example.com/'), false)
  assert.equal(samePage('not a url', 'not a url'), true)
  assert.equal(samePage('not a url', 'other'), false)
})

test('a broken map in storage reads as empty', () => {
  const map = parseMap({ root: 'r', groups: 'x', sparks: 'x' })
  assert.equal(map.root, 'r')
  assert.equal(map.groups.size, 0)
  assert.equal(map.sparks.size, 0)
})

const editCount = async (context: Setup, edit: (doc: Doc) => void): Promise<number> => {
  const writes = context.api.writes
  await context.store.commit((doc) => {
    edit(doc)
    return undefined
  })
  await context.settle()
  return context.api.writes - writes
}

test('a push writes only what changed', async () => {
  const context = await seeded()
  assert.equal(
    await editCount(context, (doc) => {
      const [first] = doc.sparks
      if (first) first.title = toLabel('renamed')
    }),
    1
  )
  assert.equal(
    await editCount(context, (doc) => {
      const group = doc.groups[1]
      if (group) group.title = toLabel('Penguins')
    }),
    1
  )
  assert.equal(
    await editCount(context, (doc) => {
      doc.sparks = doc.sparks.filter((item) => item.title !== 'b')
    }),
    1
  )
  assert.equal(
    await editCount(context, (doc) => {
      const penguins = doc.groups.find((group) => group.title === 'Penguins')
      doc.groups = doc.groups.filter((group) => group !== penguins)
      doc.sparks = doc.sparks.filter((item) => item.groupId !== penguins?.id)
    }),
    2 // the bookmark, then its folder
  )
  assert.deepEqual(context.api.shape(), [['Home', ['renamed']]])
})

test('reordering sparks in FireDial moves as few bookmarks as it takes', async () => {
  const context = await setup()
  await context.store.commit((doc) => {
    for (const title of ['a', 'b', 'c', 'd']) spark(doc, title)
    const linux = allocGroup(doc, toLabel('Linux'))
    spark(doc, 'x', linux.id)
    spark(doc, 'y', linux.id)
    return undefined
  })
  await context.settle()
  const moves = await editCount(context, (doc) => {
    doc.sparks = [...doc.sparks.slice(0, 4).reverse(), ...doc.sparks.slice(4).reverse()]
  })
  assert.deepEqual(context.api.shape(), [
    ['Home', ['d', 'c', 'b', 'a']],
    ['Linux', ['y', 'x']]
  ])
  assert.equal(moves, 4)
})

test('a removal that Firefox already made is not made again', async () => {
  const context = await seeded()
  const { api } = context
  const home = api.child('Home')
  home.children = home.children?.filter((node) => node.title !== 'b')
  api.folder().children = api.folder().children?.filter((node) => node.title !== 'Linux')
  assert.equal(
    await editCount(context, (doc) => {
      doc.sparks = doc.sparks.filter((item) => item.title === 'a')
      doc.groups = doc.groups.filter((group) => group.title !== 'Linux')
    }),
    0
  )
  assert.deepEqual(api.shape(), [['Home', ['a']]])
})

test('a group whose folder Firefox refuses stays in FireDial, the other groups sync', async () => {
  const context = await setup()
  await context.store.commit((doc) => {
    const refused = allocGroup(doc, toLabel('refused'))
    spark(doc, 'lost', refused.id)
    const linux = allocGroup(doc, toLabel('Linux'))
    spark(doc, 'c', linux.id)
    return undefined
  })
  await context.settle()
  assert.deepEqual(context.api.shape(), [
    ['Home', []],
    ['Linux', ['c']]
  ])
  assert.deepEqual(titles(context.store), ['lost', 'c'])
})

test('a push adopts only folders and bookmarks that match, one each', async () => {
  const first = await seeded()
  const { api } = first
  await api.create({ parentId: api.folder().id, title: 'Mine' })
  const kv = memory()
  const store = new Store(kv, noLock)
  await store.load()
  await store.commit((doc) => {
    spark(doc, 'a')
    spark(doc, 'a')
    spark(doc, 'd')
    return undefined
  })
  await new BookmarkSync(store, kv, api).start()
  assert.deepEqual(api.shape(), [
    ['Home', ['a', 'a', 'd', 'b']],
    ['Linux', ['c']],
    ['Mine', []]
  ])
  assert.deepEqual(
    store.doc.groups.map((group) => group.title),
    ['Home', 'Linux', 'Mine']
  )
  const map = parseMap(kv.data.get('bookmarkMap'))
  assert.equal(map.sparks.size, store.doc.sparks.length)
})

test('a fresh install finds the FireDial folder among other things of that name', async () => {
  const { api } = await seeded()
  const folder = api.folder()
  api.root.children = [
    { id: 'mark', title: 'FireDial', type: 'bookmark', url: 'https://firedial.example/' },
    { id: 'other', title: 'Other', type: 'folder', children: [] },
    folder
  ]
  const kv = memory()
  const store = new Store(kv, noLock)
  await store.load()
  await new BookmarkSync(store, kv, api).start()
  assert.equal(parseMap(kv.data.get('bookmarkMap')).root, folder.id)
  assert.deepEqual(titles(store), ['a', 'b', 'c'])
})

test('separators and bookmarks without an address are no sparks, a folder without children is a group', async () => {
  const { store, api, settle } = await seeded()
  api.folder().children?.push({ id: 'sep', title: '', type: 'separator' }, { id: 'bare', title: 'Bare', type: 'folder' })
  api
    .child('Home')
    .children?.push({ id: 'sep2', title: 'x', type: 'separator', url: 'https://sep.example/' }, { id: 'nourl', title: 'nourl', type: 'bookmark', url: null })
  await settle()
  assert.deepEqual(
    store.doc.groups.map((group) => group.title),
    ['Home', 'Linux', 'Bare']
  )
  assert.deepEqual(titles(store), ['a', 'b', 'c'])
})

test('a bookmark that lost its address keeps its spark', async () => {
  const { store, api, settle } = await seeded()
  api.child('a', api.child('Home')).url = null
  await settle()
  assert.deepEqual(titles(store), ['a', 'b', 'c'])
})

test('a bookmark from Firefox becomes a spark without an image, and the map follows deletions', async () => {
  const { kv, store, api, settle } = await seeded()
  await api.create({ parentId: api.child('Home').id, title: 'new', url: 'https://new.example/' })
  await settle()
  const created = store.doc.sparks.find((item) => item.title === 'new')
  assert.deepEqual(created && { title: created.title, url: created.url, thumb: created.thumb }, { title: 'new', url: 'https://new.example/', thumb: null })
  await api.remove(api.child('new', api.child('Home')).id)
  await api.removeTree(api.child('Linux').id)
  await settle()
  const map = parseMap(kv.data.get('bookmarkMap'))
  assert.equal(map.sparks.size, 2)
  assert.equal(map.groups.size, 1)
  assert.equal(kv.data.get('syncedRev'), store.revision)
})

test('the map is saved along the way of a long push', async () => {
  const context = await setup()
  await context.store.commit((doc) => {
    for (let index = 0; index < 120; index++) spark(doc, `s${index}`)
    return undefined
  })
  context.kv.sets.length = 0
  await context.settle()
  assert.equal(context.kv.sets.filter((keys) => keys.join() === 'bookmarkMap').length, 2)
})

test('a loose bookmark goes into its folder in the same round', async () => {
  const { store, api, sync } = await seeded()
  await api.create({ parentId: api.folder().id, title: 'loose', url: 'https://loose.example/' })
  await sync.start()
  assert.deepEqual(api.shape(), [
    ['Home', ['a', 'b', 'loose']],
    ['Linux', ['c']]
  ])
  assert.deepEqual(titles(store), ['a', 'b', 'loose', 'c'])
})

test('a pull takes everything from Firefox, even over the limits', async () => {
  const { store, api, settle } = await seeded()
  const home = api.child('Home')
  for (let index = 0; index < LIMITS.sparksPerGroup; index++)
    home.children?.push({ id: `many${index}`, title: 'm', type: 'bookmark', url: 'https://m.example/' })
  await settle()
  assert.equal(store.doc.sparks.length, LIMITS.sparksPerGroup + 3)
})

test('jobs asked for at once run one after the other', async () => {
  const context = await setup()
  await context.store.commit((doc) => {
    spark(doc, 'a')
    allocGroup(doc, toLabel('Linux'))
    return undefined
  })
  await Promise.all([context.sync.requestPush(), context.sync.requestPush(), context.sync.start()])
  assert.deepEqual(context.api.shape(), [
    ['Home', ['a']],
    ['Linux', []]
  ])
})

test('a failed job is logged and the next one runs', async (t) => {
  const context = await seeded()
  const errors = t.mock.method(console, 'error', () => undefined)
  const getChildren = t.mock.method(context.api, 'getChildren', () => Promise.reject(new Error('down')))
  context.kv.data.delete('bookmarkMap')
  await context.settle()
  assert.equal(errors.mock.callCount(), 1)
  assert.equal(errors.mock.calls[0]?.arguments[0], 'FireDial bookmark sync:')
  getChildren.mock.restore()
  await context.settle()
  assert.deepEqual(context.api.shape(), [
    ['Home', ['a', 'b']],
    ['Linux', ['c']]
  ])
})

test('a pull waits for Firefox to calm down, and pushes what FireDial changed first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { store, api, sync } = await seeded()
  const settled = async (): Promise<void> => {
    for (let turn = 0; turn < 50; turn++) await new Promise(setImmediate)
  }
  await store.commit((doc) => {
    spark(doc, 'd')
    return undefined
  })
  await sync.requestPush()
  assert.deepEqual(api.shape(), [
    ['Home', ['a', 'b', 'd']],
    ['Linux', ['c']]
  ])
  api.child('c', api.child('Linux')).title = 'renamed'
  sync.requestPull()
  t.mock.timers.tick(299)
  sync.requestPull()
  t.mock.timers.tick(299)
  await settled()
  assert.deepEqual(titles(store), ['a', 'b', 'd', 'c'])
  t.mock.timers.tick(1)
  await settled()
  assert.deepEqual(titles(store), ['a', 'b', 'd', 'renamed'])
  await store.commit((doc) => {
    spark(doc, 'e')
    return undefined
  })
  await api.create({ parentId: api.child('Linux').id, title: 'new', url: 'https://new.example/' })
  sync.requestPull()
  t.mock.timers.tick(300)
  await settled()
  assert.deepEqual(titles(store), ['a', 'b', 'd', 'e', 'renamed', 'new'])
  assert.deepEqual(api.shape(), [
    ['Home', ['a', 'b', 'd', 'e']],
    ['Linux', ['renamed', 'new']]
  ])
})
