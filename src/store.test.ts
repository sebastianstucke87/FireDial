import assert from 'node:assert/strict'
import { test } from 'node:test'

import { allocGroup, allocSpark, emptyDoc, GroupId, LimitError, LIMITS, newThumbId, nextGroupName, SparkId, SparkUrl, toLabel } from './model.ts'
import type { Doc, Spark } from './model.ts'
import { Store, thumbKey } from './store.ts'
import type { KeyValue, Lock } from './store.ts'

// Storage with the semantics Firefox has: values cloned on the way in and out, one change event per write.
function memory(initial: Record<string, unknown> = {}): KeyValue & { data: Map<string, unknown> } {
  const data = new Map(Object.entries(initial))
  const listeners: ((keys: ReadonlySet<string>) => void)[] = []
  const notify = (keys: string[]): void => {
    for (const listener of listeners) listener(new Set(keys))
  }
  return {
    data,
    get(keys) {
      const list = [keys].flat()
      return Promise.resolve(Object.fromEntries(list.filter((key) => data.has(key)).map((key) => [key, structuredClone(data.get(key))])))
    },
    set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value))
      notify(Object.keys(items))
      return Promise.resolve()
    },
    remove(keys) {
      for (const key of [keys].flat()) data.delete(key)
      return Promise.resolve()
    },
    onChanged(listener) {
      listeners.push(listener)
    }
  }
}

// One queue, like navigator.locks across tabs.
function queue(): Lock {
  let tail: Promise<unknown> = Promise.resolve()
  return (task) => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}

const url = (text: string): SparkUrl => SparkUrl.parse(text)

function addSpark(doc: Doc, title: string, groupId?: GroupId): Spark {
  const target = groupId ?? doc.groups[0]?.id
  assert.notEqual(target, undefined)
  return allocSpark(doc, {
    groupId: target ?? doc.groups[0]?.id ?? allocGroup(doc, toLabel('x')).id,
    title: toLabel(title),
    url: url(`https://${title}.example/`),
    thumb: null
  })
}

const add = (store: Store, title: string): Promise<boolean> =>
  store.commit((doc) => {
    addSpark(doc, title)
    return undefined
  })

const titles = (store: Store): string[] => store.doc.sparks.map((spark) => spark.title)

async function tabs(count: number, kv = memory()): Promise<Store[]> {
  const lock = queue()
  const stores = Array.from({ length: count }, () => new Store(kv, lock))
  for (const store of stores) await store.load()
  return stores
}

test('undo and redo walk through changes', async () => {
  const [store] = await tabs(1)
  assert.ok(store)
  await add(store, 'a')
  await add(store, 'b')
  await store.undo()
  assert.deepEqual(titles(store), ['a'])
  await store.undo()
  assert.deepEqual(titles(store), [])
  assert.equal(store.canUndo, false)
  await store.redo()
  await store.redo()
  assert.deepEqual(titles(store), ['a', 'b'])
  assert.equal(store.canRedo, false)
})

test('a new change after undo drops the redo steps', async () => {
  const kv = memory()
  const [store] = await tabs(1, kv)
  assert.ok(store)
  await add(store, 'a')
  await add(store, 'b')
  await store.undo()
  await add(store, 'c')
  assert.equal(store.canRedo, false)
  assert.deepEqual(titles(store), ['a', 'c'])
  assert.equal([...kv.data.keys()].filter((key) => key.startsWith('step:')).length, 2)
})

test('#18: tabs share one history', async () => {
  const [first, second] = await tabs(2)
  assert.ok(first && second)
  await add(first, 'a')
  assert.equal(await second.refresh(), true)
  assert.equal(second.canUndo, true)
  await second.undo()
  await first.refresh()
  assert.deepEqual(titles(first), [])
  assert.equal(first.canRedo, true)
})

test('history survives a restart', async () => {
  const kv = memory()
  const [before] = await tabs(1, kv)
  assert.ok(before)
  await add(before, 'a')
  const [after] = await tabs(1, kv)
  assert.ok(after)
  assert.equal(after.canUndo, true)
  await after.undo()
  assert.deepEqual(titles(after), [])
})

test('tabs writing at once lose nothing', async () => {
  const [first, second] = await tabs(2)
  assert.ok(first && second)
  await Promise.all([add(first, 'a'), add(second, 'b'), add(first, 'c'), add(second, 'd')])
  await first.refresh()
  assert.equal(first.doc.sparks.length, 4)
})

test('undo restores a removed spark at its place, image included', async () => {
  const [store] = await tabs(1)
  assert.ok(store)
  const thumb = newThumbId()
  await store.commit(
    (doc) => {
      addSpark(doc, 'a')
      const spark = addSpark(doc, 'b')
      spark.thumb = thumb
      addSpark(doc, 'c')
      return undefined
    },
    { thumbs: { [thumb]: 'data:image' } }
  )
  await store.commit((doc) => {
    doc.sparks = doc.sparks.filter((spark) => spark.title !== 'b')
    return undefined
  })
  await store.undo()
  assert.deepEqual(titles(store), ['a', 'b', 'c'])
  assert.equal((await store.thumbs([thumb])).get(thumb), 'data:image')
})

test('undo restores a removed group with its sparks and returns to it', async () => {
  const [store] = await tabs(1)
  assert.ok(store)
  let groupId: GroupId | undefined
  await store.commit((doc) => {
    const group = allocGroup(doc, toLabel('Linux'))
    groupId = group.id
    addSpark(doc, 'distrosea', group.id)
    return group.id
  })
  assert.ok(groupId !== undefined)
  const shown = groupId
  await store.commit(
    (doc) => {
      doc.sparks = doc.sparks.filter((spark) => spark.groupId !== shown)
      doc.groups = doc.groups.filter((group) => group.id !== shown)
      return undefined
    },
    { active: shown }
  )
  assert.equal(store.doc.groups.length, 1)
  assert.equal(await store.undo(), shown)
  assert.equal(store.doc.groups.length, 2)
  assert.deepEqual(titles(store), ['distrosea'])
})

test('removing the last group leaves a fresh one', async () => {
  const [store] = await tabs(1)
  assert.ok(store)
  await store.commit((doc) => {
    doc.groups = []
    return undefined
  })
  assert.equal(store.doc.groups.length, 1)
  assert.notEqual(store.doc.groups[0]?.id, 0)
})

test('a change touching nothing leaves no step', async () => {
  const [store] = await tabs(1)
  assert.ok(store)
  await store.commit(() => undefined)
  assert.equal(store.canUndo, false)
})

test('#13: limits refuse a change and leave the doc alone', async () => {
  const [store] = await tabs(1)
  assert.ok(store)
  await assert.rejects(
    store.commit((doc) => {
      for (let count = 0; count <= LIMITS.sparksPerGroup; count++) addSpark(doc, 'x')
      return undefined
    }),
    LimitError
  )
  assert.equal(store.doc.sparks.length, 0)
  assert.equal(store.canUndo, false)
})

test('#13: the oldest undo steps fall off', async () => {
  const kv = memory({ schema: 3, history: { first: 5, cursor: 5 + LIMITS.undo, end: 5 + LIMITS.undo } })
  const [store] = await tabs(1, kv)
  assert.ok(store)
  await add(store, 'a')
  const history = kv.data.get('history')
  assert.deepEqual(history, { first: 6, cursor: 6 + LIMITS.undo, end: 6 + LIMITS.undo })
})

test('the first start runs once: a second load changes nothing', async () => {
  const kv = memory({ groups: [{ id: 0, title: 'Home' }], sparks: [] })
  const [store] = await tabs(1, kv)
  assert.ok(store)
  await add(store, 'a')
  const [again] = await tabs(1, kv)
  assert.ok(again)
  assert.deepEqual(titles(again), ['a'])
})

test('import replaces everything and clears history', async () => {
  const kv = memory()
  const [store] = await tabs(1, kv)
  assert.ok(store)
  await add(store, 'old')
  const before = store.doc.nextSparkId
  await store.replaceAll({
    groups: [{ key: 40, title: toLabel('Imported') }],
    sparks: [{ groupKey: 40, title: toLabel('new'), url: url('https://new.example/'), src: 'data:new' }],
    prefs: store.doc.prefs
  })
  assert.deepEqual(titles(store), ['new'])
  assert.equal(store.canUndo, false)
  assert.ok(SparkId.parse(store.doc.sparks[0]?.id) >= before)
  assert.equal([...kv.data.keys()].filter((key) => key.startsWith('step:')).length, 0)
})

test('collectGarbage keeps images the history can reach and drops the rest', async () => {
  const kv = memory()
  const [store] = await tabs(1, kv)
  assert.ok(store)
  const [one, two] = [newThumbId(), newThumbId()]
  await store.commit(
    (doc) => {
      addSpark(doc, 'a').thumb = one
      return undefined
    },
    { thumbs: { [one]: 'data:one' } }
  )
  await store.commit(
    (doc) => {
      const spark = doc.sparks[0]
      if (spark) spark.thumb = two
      return undefined
    },
    { thumbs: { [two]: 'data:two' } }
  )
  assert.equal(await store.collectGarbage(), 0)
  await store.undo()
  await store.undo() // back to no sparks; both images only reachable through redo
  assert.equal(await store.collectGarbage(), 0)
  await add(store, 'b') // drops the redo steps
  assert.equal(await store.collectGarbage(), 2)
  assert.equal(kv.data.has(thumbKey(one)), false)
  assert.equal(kv.data.has(thumbKey(two)), false)
})

test('colors are kept per image, and go with the image', async () => {
  const kv = memory()
  const [store] = await tabs(1, kv)
  assert.ok(store)
  const [kept, dropped] = [newThumbId(), newThumbId()]
  await store.commit(
    (doc) => {
      addSpark(doc, 'a').thumb = kept
      addSpark(doc, 'b').thumb = dropped
      return undefined
    },
    { thumbs: { [kept]: 'data:kept', [dropped]: 'data:dropped' } }
  )
  await store.saveColors(
    new Map([
      [kept, '#112233'],
      [dropped, '#445566']
    ])
  )
  await store.commit((doc) => {
    doc.sparks = doc.sparks.filter((spark) => spark.thumb === kept)
    return undefined
  })
  for (const key of [...kv.data.keys()].filter((name) => name.startsWith('step:'))) kv.data.delete(key) // nothing can undo back to the image
  await kv.set({ history: { first: 0, cursor: 0, end: 0 } })
  await store.load()
  await store.collectGarbage()
  assert.deepEqual([...(await store.colors())], [[kept, '#112233']])
})

test('#30: new groups count up', () => {
  const groups = [{ id: GroupId.parse(0), title: toLabel('New Group #4') }]
  assert.equal(nextGroupName(groups), 'New Group #5')
  assert.equal(nextGroupName([]), 'New Group #1')
})

// Storage that also tells which keys each write had.
function spied(initial: Record<string, unknown> = {}): ReturnType<typeof memory> & { writes: string[][] } {
  const kv = memory(initial)
  const writes: string[][] = []
  return {
    ...kv,
    set(items) {
      writes.push(Object.keys(items).sort())
      return kv.set(items)
    },
    writes
  }
}

const stepCount = (kv: ReturnType<typeof memory>): number => [...kv.data.keys()].filter((key) => key.startsWith('step:')).length

test('the first start sets up an empty FireDial at revision 1, a later one reads what is there', async () => {
  const kv = spied()
  const [store] = await tabs(1, kv)
  assert.ok(store)
  assert.equal(store.revision, 1)
  assert.deepEqual(
    store.doc.groups.map((group) => group.title),
    ['Home']
  )
  await store.commit((doc) => {
    allocGroup(doc, toLabel('Work'))
    doc.prefs.columns = 7
    return undefined
  })
  const writes = kv.writes.length
  const [again] = await tabs(1, kv)
  assert.ok(again)
  assert.equal(kv.writes.length, writes, 'no write')
  assert.equal(again.revision, 2)
  assert.equal(again.doc.prefs.columns, 7)
  assert.equal(again.doc.nextGroupId, 2)
})

test('broken stored data reads as empty', async () => {
  const kv = memory({ schema: 3, rev: 'x', groups: 'x', sparks: 7, prefs: null, nextIds: 'x', history: 'x' })
  const [store] = await tabs(1, kv)
  assert.ok(store)
  assert.deepEqual(store.doc, { ...emptyDoc(), groups: [{ id: 1, title: 'Home' }], nextGroupId: 2 })
  assert.equal(store.revision, 0)
  assert.equal(store.canUndo, false)
  assert.equal(store.canRedo, false)
})

test('a change writes only what it touched, and counts the revision up', async () => {
  const kv = spied()
  const [store] = await tabs(1, kv)
  assert.ok(store)
  const write = async (mutate: (doc: Doc) => void): Promise<string[]> => {
    kv.writes.length = 0
    await store.commit((doc) => {
      mutate(doc)
      return undefined
    })
    return kv.writes.flat().filter((key) => !key.startsWith('step:'))
  }
  assert.deepEqual(await write((doc) => addSpark(doc, 'a')), ['history', 'nextIds', 'rev', 'sparks'])
  assert.deepEqual(await write((doc) => allocGroup(doc, toLabel('Work'))), ['groups', 'history', 'nextIds', 'rev'])
  assert.deepEqual(await write((doc) => doc.groups.reverse()), ['groups', 'history', 'nextIds', 'rev'])
  assert.deepEqual(
    await write((doc) => {
      doc.prefs.columns = 6
    }),
    ['history', 'nextIds', 'prefs', 'rev']
  )
  assert.equal(store.revision, 5)
  kv.writes.length = 0
  await store.undo()
  assert.deepEqual(kv.writes, [['history', 'nextIds', 'prefs', 'rev']])
  assert.equal(store.revision, 6)
})

test('only a commit at the expected revision goes through', async () => {
  const [store] = await tabs(1)
  assert.ok(store)
  const addA = (doc: Doc): undefined => {
    addSpark(doc, 'a')
    return undefined
  }
  assert.equal(await store.commit(addA, { ifRevision: 0 }), false)
  assert.deepEqual(titles(store), [])
  assert.equal(await store.commit(addA, { ifRevision: 1 }), true)
  assert.deepEqual(titles(store), ['a'])
})

test('undo returns to the group shown before, redo to the one shown after', async () => {
  const [store] = await tabs(1)
  assert.ok(store)
  const work = GroupId.parse(5)
  const home = GroupId.parse(0)
  await store.commit(
    (doc) => {
      addSpark(doc, 'a')
      return undefined
    },
    { active: work }
  )
  assert.equal(await store.undo(), work)
  assert.equal(await store.redo(), work)
  await store.commit((doc) => {
    addSpark(doc, 'b')
    return home
  })
  assert.equal(await store.undo(), null)
  assert.equal(await store.redo(), home)
})

test('data from outside may go over the limits', async () => {
  const [store] = await tabs(1)
  assert.ok(store)
  await store.commit(
    (doc) => {
      for (let count = 0; count <= LIMITS.sparksPerGroup; count++) addSpark(doc, 'x')
      return undefined
    },
    { unchecked: true }
  )
  assert.equal(store.doc.sparks.length, LIMITS.sparksPerGroup + 1)
})

test('undo keeps exactly the limit of steps, the oldest one goes', async () => {
  const end = LIMITS.undo - 1
  const kv = memory({ schema: 3, history: { first: 0, cursor: end, end }, 'step:0': {} })
  const [store] = await tabs(1, kv)
  assert.ok(store)
  await add(store, 'a')
  assert.deepEqual(kv.data.get('history'), { first: 0, cursor: LIMITS.undo, end: LIMITS.undo })
  assert.ok(kv.data.has('step:0'))
  await add(store, 'b')
  assert.deepEqual(kv.data.get('history'), { first: 1, cursor: LIMITS.undo + 1, end: LIMITS.undo + 1 })
  assert.ok(!kv.data.has('step:0'))
})

test('a new change after undo removes the redo steps from storage, images are only listed when there are some', async () => {
  const kv = spied()
  const [store] = await tabs(1, kv)
  assert.ok(store)
  await add(store, 'a')
  await add(store, 'b')
  await store.undo()
  await store.undo()
  assert.equal(stepCount(kv), 2)
  kv.writes.length = 0
  await add(store, 'c')
  assert.equal(stepCount(kv), 1)
  assert.ok(!kv.writes.flat().includes('thumbIndex'))
})

test('undo and redo with nothing to go to write nothing, but catch up with the other tabs', async () => {
  const kv = spied()
  const [a, b] = await tabs(2, kv)
  assert.ok(a && b)
  await add(b, 'x')
  await b.undo()
  const writes = kv.writes.length
  assert.equal(await b.undo(), null)
  assert.equal(kv.writes.length, writes)
  assert.equal(await a.undo(), null)
  assert.equal(kv.writes.length, writes)
  assert.equal(a.canRedo, true, 'a caught up')
  await b.redo()
  const revision = b.revision
  assert.equal(await b.redo(), null)
  assert.equal(b.revision, revision)
  assert.equal(b.canUndo, true)
})

test('a lost undo step still moves through the history', async () => {
  const kv = memory()
  const [store] = await tabs(1, kv)
  assert.ok(store)
  await add(store, 'a')
  kv.data.delete('step:0')
  assert.equal(await store.undo(), null)
  assert.equal(store.canUndo, false)
  assert.deepEqual(titles(store), ['a'])
})

test('other tabs hear about changes, not about colors, and refresh tells whether there was news', async () => {
  const kv = memory()
  const [a, b] = await tabs(2, kv)
  assert.ok(a && b)
  let heard = 0
  a.watch(() => {
    heard += 1
  })
  assert.equal(await a.refresh(), false)
  await add(b, 'x')
  assert.equal(heard, 1)
  await b.saveColors(new Map())
  assert.equal(heard, 1)
  assert.equal(await a.refresh(), true)
  assert.deepEqual(titles(a), ['x'])
})

test('import: stray sparks join the first group or are dropped without one, every image is kept, the old ones go', async () => {
  const kv = memory()
  const [store] = await tabs(1, kv)
  assert.ok(store)
  const old = newThumbId()
  await store.commit(
    (doc) => {
      addSpark(doc, 'old').thumb = old
      return undefined
    },
    { thumbs: { [old]: 'data:old' } }
  )
  await store.saveColors(new Map([[old, '#000000']]))
  const many = 450
  const first = await store.replaceAll({
    groups: [
      { key: 1, title: toLabel('One') },
      { key: 2, title: toLabel('Two') }
    ],
    sparks: [
      { groupKey: 2, title: toLabel('two'), url: url('https://two.example/'), src: '' },
      { groupKey: 9, title: toLabel('stray'), url: url('https://stray.example/'), src: '' },
      ...Array.from({ length: many }, (_, index) => ({ groupKey: 1, title: toLabel(`p${index}`), url: url('https://p.example/'), src: `data:${index}` }))
    ],
    prefs: store.doc.prefs
  })
  assert.equal(first, store.doc.groups[0]?.id)
  assert.deepEqual(titles(store).slice(0, 2), ['stray', 'p0'])
  assert.equal(titles(store).at(-1), 'two')
  const ids = store.doc.sparks.flatMap((spark) => (spark.thumb ? [spark.thumb] : []))
  assert.equal(ids.length, many)
  const images = await store.thumbs(ids)
  assert.equal(images.get(ids[many - 1] ?? newThumbId()), `data:${many - 1}`)
  assert.deepEqual(kv.data.get('thumbIndex'), ids)
  assert.ok(!kv.data.has(thumbKey(old)))
  assert.ok(!kv.data.has('thumbColors'))
  const groupless = await store.replaceAll({
    groups: [],
    sparks: [{ groupKey: 0, title: toLabel('a'), url: url('https://a.example/'), src: '' }],
    prefs: store.doc.prefs
  })
  assert.deepEqual(titles(store), [])
  assert.equal(groupless, store.doc.groups[0]?.id)
})

test('import refuses more than a group holds', async () => {
  const [store] = await tabs(1)
  assert.ok(store)
  const spark = { groupKey: 0, title: toLabel('s'), url: url('https://s.example/'), src: '' }
  await assert.rejects(
    store.replaceAll({
      groups: [{ key: 0, title: toLabel('g') }],
      sparks: Array.from({ length: LIMITS.sparksPerGroup + 1 }, () => spark),
      prefs: store.doc.prefs
    }),
    LimitError
  )
})

test('only image ids count as colors', async () => {
  const kv = memory()
  const [store] = await tabs(1, kv)
  assert.ok(store)
  kv.data.set('thumbColors', { '': '#ffffff', a: '#000000' })
  assert.deepEqual([...(await store.colors())], [['a', '#000000']])
})

test('collectGarbage with nothing to drop writes nothing, and steps it cannot read do not stop it', async () => {
  const kv = spied()
  const [store] = await tabs(1, kv)
  assert.ok(store)
  const live = newThumbId()
  await store.commit(
    (doc) => {
      addSpark(doc, 'a').thumb = live
      return undefined
    },
    { thumbs: { [live]: 'data:a' } }
  )
  kv.data.set('step:0', 'garbage')
  const writes = kv.writes.length
  assert.equal(await store.collectGarbage(), 0)
  assert.equal(kv.writes.length, writes)
  assert.deepEqual(kv.data.get('thumbIndex'), [live])
})
