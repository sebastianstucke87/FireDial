import assert from 'node:assert/strict'
import { test } from 'node:test'

import { addTo, allocSpark, allocView, emptyDoc, LabelName, LimitError, LIMITS, makeView, newThumbId, SparkId, SparkUrl, toLabel, ViewId } from './model.ts'
import type { Doc, Spark } from './model.ts'
import { Store, thumbKey } from './store.ts'
import type { KeyValue, Lock } from './store.ts'

// Small limits: the limit tests then build 1,000 sparks, not 100,000, which matters for mutation testing.
Object.assign(LIMITS, { views: 20, sparks: 1000 })

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

function addSpark(doc: Doc, title: string, viewId?: ViewId): Spark {
  const spark = allocSpark(doc, { title: toLabel(title), url: url(`https://${title}.example/`), thumb: null })
  const view = doc.views.find((each) => each.id === viewId)
  if (view) addTo([spark], view)
  return spark
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

test('undo restores a removed view with its sparks and returns to it', async () => {
  const [store] = await tabs(1)
  assert.ok(store)
  let viewId: ViewId | undefined
  await store.commit((doc) => {
    const view = allocView(doc, 'Linux')
    viewId = view.id
    addSpark(doc, 'distrosea', view.id)
    return view.id
  })
  assert.ok(viewId !== undefined)
  const shown = viewId
  await store.commit(
    (doc) => {
      doc.sparks = []
      doc.views = doc.views.filter((view) => view.id !== shown)
      return undefined
    },
    { active: shown }
  )
  assert.equal(store.doc.views.length, 2)
  assert.equal(await store.undo(), shown)
  assert.equal(store.doc.views.length, 3)
  assert.deepEqual(titles(store), ['distrosea'])
})

test('removing every view leaves All and Unlabeled', async () => {
  const [store] = await tabs(1)
  assert.ok(store)
  await store.commit((doc) => {
    doc.views = []
    return undefined
  })
  assert.deepEqual(
    store.doc.views.map((view) => view.kind),
    ['all', 'unlabeled']
  )
  assert.notEqual(store.doc.views[0]?.id, 0)
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
      for (let count = 0; count <= LIMITS.sparks; count++) addSpark(doc, 'x')
      return undefined
    }),
    LimitError
  )
  assert.equal(store.doc.sparks.length, 0)
  assert.equal(store.canUndo, false)
})

test('#13: the oldest undo steps fall off', async () => {
  const kv = memory({ schema: 4, history: { first: 5, cursor: 5 + LIMITS.undo, end: 5 + LIMITS.undo } })
  const [store] = await tabs(1, kv)
  assert.ok(store)
  await add(store, 'a')
  const history = kv.data.get('history')
  assert.deepEqual(history, { first: 6, cursor: 6 + LIMITS.undo, end: 6 + LIMITS.undo })
})

test('the first start runs once: a second load changes nothing', async () => {
  const kv = memory({ views: [], sparks: [] })
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
    views: [{ kind: 'normal', title: LabelName.parse('Imported'), sort: 'manual', rule: { all: false, include: [], exclude: [] }, order: [40] }],
    sparks: [{ key: 40, title: toLabel('new'), url: url('https://new.example/'), src: 'data:new', labels: [LabelName.parse('Imported')] }],
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
    store.doc.views.map((view) => view.title),
    ['All', 'Unlabeled']
  )
  await store.commit((doc) => {
    allocView(doc, 'Work')
    doc.prefs.columns = 7
    return undefined
  })
  const writes = kv.writes.length
  const [again] = await tabs(1, kv)
  assert.ok(again)
  assert.equal(kv.writes.length, writes, 'no write')
  assert.equal(again.revision, 2)
  assert.equal(again.doc.prefs.columns, 7)
  assert.equal(again.doc.nextViewId, 3)
})

test('broken stored data reads as empty', async () => {
  const kv = memory({ schema: 4, rev: 'x', views: 'x', sparks: 7, prefs: null, nextIds: 'x', history: 'x' })
  const [store] = await tabs(1, kv)
  assert.ok(store)
  const views = [makeView(ViewId.parse(3), 'all', LabelName.parse('All')), makeView(ViewId.parse(2), 'unlabeled', LabelName.parse('Unlabeled'))]
  assert.deepEqual(store.doc, { ...emptyDoc(), views, nextViewId: 4 })
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
  assert.deepEqual(await write((doc) => addSpark(doc, 'a')), ['history', 'nextIds', 'rev', 'sparks', 'views'])
  assert.deepEqual(await write((doc) => allocView(doc, 'Work')), ['history', 'nextIds', 'rev', 'views'])
  assert.deepEqual(await write((doc) => doc.views.reverse()), ['history', 'nextIds', 'rev', 'views'])
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

test('undo returns to the view shown before, redo to the one shown after', async () => {
  const [store] = await tabs(1)
  assert.ok(store)
  const work = ViewId.parse(5)
  const home = ViewId.parse(0)
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
      for (let count = 0; count <= LIMITS.sparks; count++) addSpark(doc, 'x')
      return undefined
    },
    { unchecked: true }
  )
  assert.equal(store.doc.sparks.length, LIMITS.sparks + 1)
})

test('undo keeps exactly the limit of steps, the oldest one goes', async () => {
  const end = LIMITS.undo - 1
  const kv = memory({ schema: 4, history: { first: 0, cursor: end, end }, 'step:0': {} })
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

test('import: views keep their order by key, unknown keys drop out, every image is kept, the old ones go', async () => {
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
  const rule = { all: false, include: [], exclude: [] }
  const one = LabelName.parse('One')
  const first = await store.replaceAll({
    views: [
      { kind: 'normal', title: one, sort: 'manual', rule, order: [9, 2, 1] },
      { kind: 'all', title: LabelName.parse('Everything'), sort: 'name', rule, order: [] },
      { kind: 'normal', title: LabelName.parse('one'), sort: 'manual', rule, order: [] }
    ],
    sparks: [
      { key: 1, title: toLabel('p'), url: url('https://p.example/'), src: '', labels: [one] },
      { key: 2, title: toLabel('two'), url: url('https://two.example/'), src: '', labels: [one] },
      ...Array.from({ length: many }, (_, index) => ({
        key: 100 + index,
        title: toLabel(`p${index}`),
        url: url('https://p.example/'),
        src: `data:${index}`,
        labels: []
      }))
    ],
    prefs: store.doc.prefs
  })
  assert.deepEqual(
    store.doc.views.map((view) => [view.kind, view.title, view.sort]),
    [
      ['unlabeled', 'Unlabeled', 'name'],
      ['normal', 'One', 'manual'],
      ['all', 'Everything', 'name']
    ],
    'the second "one" is the same view; Unlabeled comes back'
  )
  assert.equal(first, store.doc.views[2]?.id, 'All shows first')
  const view = store.doc.views[1]
  assert.ok(view)
  assert.deepEqual(
    view.order.map((id) => store.doc.sparks.find((spark) => spark.id === id)?.title),
    ['two', 'p']
  )
  const ids = store.doc.sparks.flatMap((spark) => (spark.thumb ? [spark.thumb] : []))
  assert.equal(ids.length, many)
  const images = await store.thumbs(ids)
  assert.equal(images.get(ids[many - 1] ?? newThumbId()), `data:${many - 1}`)
  assert.deepEqual(kv.data.get('thumbIndex'), ids)
  assert.ok(!kv.data.has(thumbKey(old)))
  assert.ok(!kv.data.has('thumbColors'))
})

test('import refuses more sparks than FireDial holds', async () => {
  const [store] = await tabs(1)
  assert.ok(store)
  const spark = { key: 0, title: toLabel('s'), url: url('https://s.example/'), src: '', labels: [] }
  await assert.rejects(
    store.replaceAll({
      views: [],
      sparks: Array.from({ length: LIMITS.sparks + 1 }, () => spark),
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

test('an import is one revision on, for every tab, and shows All', async () => {
  const kv = memory()
  const [a, b] = await tabs(2, kv)
  assert.ok(a && b)
  const before = a.revision
  const all = await a.replaceAll({
    views: [],
    sparks: [{ key: 1, title: toLabel('x'), url: url('https://x.example/'), src: '', labels: [] }],
    prefs: a.doc.prefs
  })
  assert.equal(a.revision, before + 1)
  assert.equal(all, a.doc.views.find((view) => view.kind === 'all')?.id)
  assert.equal(await b.refresh(), true)
  assert.equal(b.revision, before + 1)
  assert.equal(b.doc.sparks.length, 1)
})
