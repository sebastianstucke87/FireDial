import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applySide, diff, parseStep, stepKey, stepThumbs } from './history.ts'
import { addLabels, addTo, allocSpark, allocView, canonicalize, emptyDoc, LabelName, moveInView, newThumbId, SparkUrl, toLabel, ViewId } from './model.ts'
import type { Doc, Spark, ThumbId, View } from './model.ts'

const ALL = ViewId.parse(0)

// All, Unlabeled, Home (a, b) and Work (c, d).
function doc(): Doc {
  const value = emptyDoc()
  const home = allocView(value, 'Home')
  const work = allocView(value, 'Work')
  for (const [view, title] of [
    [home, 'a'],
    [home, 'b'],
    [work, 'c'],
    [work, 'd']
  ] as const)
    addTo([allocSpark(value, { title: toLabel(title), url: SparkUrl.parse(`https://${title}.example`), thumb: null })], view)
  canonicalize(value)
  return value
}

const titles = (value: Doc): string[] => value.sparks.map((spark) => `${spark.labels.join('+')}:${spark.title}`)
const viewTitles = (value: Doc): string[] => value.views.map((view) => view.title)
const viewOf = (value: Doc, title: string): View => {
  const view = value.views.find((each) => each.title === title)
  assert.ok(view, title)
  return view
}

// Makes a change, then checks that its step leads back and forth between both docs.
function roundTrip(change: (value: Doc) => void): { before: Doc; after: Doc } {
  const before = doc()
  const after = structuredClone(before)
  change(after)
  canonicalize(after)
  const step = diff(before, after, ALL, ALL)
  assert.ok(step)
  const back = structuredClone(after)
  applySide(back, step.before)
  assert.deepEqual(back, { ...before, nextViewId: after.nextViewId, nextSparkId: after.nextSparkId })
  const forth = structuredClone(before)
  applySide(forth, step.after)
  assert.deepEqual({ ...forth, nextViewId: after.nextViewId, nextSparkId: after.nextSparkId }, after)
  return { before, after }
}

test('no change is no step', () => {
  assert.equal(diff(doc(), doc(), ALL, ALL), null)
})

test('a step undoes and redoes added, removed, edited and relabeled sparks', () => {
  roundTrip((value) => {
    addTo([allocSpark(value, { title: toLabel('e'), url: SparkUrl.parse('https://e.example'), thumb: null })], viewOf(value, 'Home'))
  })
  roundTrip((value) => {
    value.sparks = value.sparks.filter((spark) => spark.title !== 'b')
  })
  roundTrip((value) => {
    const [first] = value.sparks
    if (first) first.title = toLabel('renamed')
  })
  roundTrip((value) => {
    addTo(
      value.sparks.filter((spark) => spark.title === 'a'),
      viewOf(value, 'Work')
    )
  })
})

test('a step undoes and redoes the order of sparks, of a view and of views', () => {
  roundTrip((value) => {
    const all = viewOf(value, 'All')
    moveInView(value, all, all.order.slice(1, 2), all.order[0] ?? null, false)
  })
  roundTrip((value) => {
    const work = viewOf(value, 'Work')
    moveInView(value, work, work.order.slice(1, 2), work.order[0] ?? null, false)
  })
  roundTrip((value) => {
    value.views.reverse()
  })
  roundTrip((value) => {
    viewOf(value, 'Home').sort = 'date'
  })
})

test('a step undoes and redoes added views and settings', () => {
  roundTrip((value) => {
    allocView(value, 'New')
  })
  roundTrip((value) => {
    value.prefs = { ...value.prefs, columns: 7 }
  })
})

test('a step tells what each side looked like, and only what changed', () => {
  const before = doc()
  const after = structuredClone(before)
  allocSpark(after, { title: toLabel('e'), url: SparkUrl.parse('https://e.example'), thumb: null })
  canonicalize(after)
  const step = diff(before, after, ALL, ViewId.parse(2))
  assert.ok(step)
  assert.deepEqual(
    step.before.sparks.map(({ id, value }) => [id, value]),
    [[4, null]]
  )
  assert.equal(step.after.sparks[0]?.value?.title, 'e')
  assert.deepEqual(
    step.after.views.map(({ value }) => value?.title),
    ['All', 'Unlabeled'],
    'the views whose order took the new spark'
  )
  assert.deepEqual(step.before.sparkOrder, [0, 1, 2, 3])
  assert.deepEqual(step.after.sparkOrder, [0, 1, 2, 3, 4])
  assert.equal(step.before.viewOrder, null)
  assert.equal(step.before.prefs, null)
  assert.deepEqual([step.before.active, step.after.active], [0, 2])
})

test('undo leaves what others changed since then', () => {
  const before = doc()
  const after = structuredClone(before)
  after.views.reverse()
  const step = diff(before, after, ALL, ALL)
  assert.ok(step)
  const now = structuredClone(after)
  const theirs = allocView(now, 'Theirs')
  allocSpark(now, { title: toLabel('x'), url: SparkUrl.parse('https://x.example'), thumb: null })
  now.prefs.columns = 6
  canonicalize(now)
  applySide(now, step.before)
  assert.deepEqual(viewTitles(now), ['All', 'Unlabeled', 'Home', 'Work', 'Theirs'])
  assert.deepEqual(titles(now), ['Home:a', 'Home:b', 'Work:c', 'Work:d', ':x'])
  assert.equal(now.prefs.columns, 6)
  assert.ok(now.views.some((view) => view.id === theirs.id))
})

test('the thumbnails a step holds on to', () => {
  const thumbs: ThumbId[] = [newThumbId(), newThumbId()]
  const before = doc()
  const after = structuredClone(before)
  const [first, second] = after.sparks
  if (first) first.thumb = thumbs[0] ?? null
  if (second) second.thumb = thumbs[1] ?? null
  const step = diff(before, after, ALL, ALL)
  assert.ok(step)
  assert.deepEqual(stepThumbs(step), thumbs)
})

test('a stored step reads back as it was, its settings checked', () => {
  const before = doc()
  const after = structuredClone(before)
  after.prefs = { ...after.prefs, columns: 7 }
  allocSpark(after, { title: toLabel('e'), url: SparkUrl.parse('https://e.example'), thumb: null })
  canonicalize(after)
  const step = diff(before, after, ALL, ALL)
  assert.deepEqual(parseStep(JSON.parse(JSON.stringify(step))), step)
  assert.ok(step)
  const { prefs: _, ...withoutPrefs } = step.before
  const stored = { before: withoutPrefs, after: { ...step.after, prefs: { columns: 99 } } }
  assert.equal(parseStep(stored)?.after.prefs?.columns, 8)
  assert.equal(parseStep(stored)?.before.prefs, null)
  assert.equal(parseStep('garbage'), null)
  assert.equal(stepKey(3), 'step:3')
})

test('labels added on sparks of two views go back with one step', () => {
  const docs = LabelName.parse('docs')
  const { before, after } = roundTrip((value) => {
    assert.equal(
      addLabels(
        value.sparks.filter((spark) => ['a', 'c'].includes(spark.title)),
        [docs]
      ),
      2
    )
  })
  assert.deepEqual(
    before.sparks.map((spark: Spark) => spark.labels),
    [['Home'], ['Home'], ['Work'], ['Work']]
  )
  assert.deepEqual(
    after.sparks.map((spark: Spark) => spark.labels),
    [['Home', 'docs'], ['Home'], ['Work', 'docs'], ['Work']]
  )
  const step = diff(before, after, ALL, ALL)
  assert.ok(step)
  assert.deepEqual(parseStep(JSON.parse(JSON.stringify(step))), step, 'a stored step keeps the labels')
})
