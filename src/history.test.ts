import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applySide, diff, parseStep, stepKey, stepThumbs } from './history.ts'
import { allocGroup, allocSpark, canonicalize, emptyDoc, GroupId, newThumbId, SparkUrl, toLabel } from './model.ts'
import type { Doc, Spark, ThumbId } from './model.ts'

const HOME = GroupId.parse(0)

function doc(): Doc {
  const value = emptyDoc()
  const work = allocGroup(value, toLabel('Work'))
  for (const [groupId, title] of [
    [HOME, 'a'],
    [HOME, 'b'],
    [work.id, 'c'],
    [work.id, 'd']
  ] as const)
    allocSpark(value, { groupId, title: toLabel(title), url: SparkUrl.parse(`https://${title}.example`), thumb: null })
  return value
}

const titles = (value: Doc): string[] => value.sparks.map((spark) => `${spark.groupId}:${spark.title}`)
const groupTitles = (value: Doc): string[] => value.groups.map((group) => group.title)

// Makes a change, then checks that its step leads back and forth between both docs.
function roundTrip(change: (value: Doc) => void): { before: Doc; after: Doc } {
  const before = doc()
  const after = structuredClone(before)
  change(after)
  canonicalize(after)
  const step = diff(before, after, HOME, HOME)
  assert.ok(step)
  const back = structuredClone(after)
  applySide(back, step.before)
  assert.deepEqual(back, { ...before, nextGroupId: after.nextGroupId, nextSparkId: after.nextSparkId })
  const forth = structuredClone(before)
  applySide(forth, step.after)
  assert.deepEqual({ ...forth, nextGroupId: after.nextGroupId, nextSparkId: after.nextSparkId }, after)
  return { before, after }
}

test('no change is no step', () => {
  assert.equal(diff(doc(), doc(), HOME, HOME), null)
})

test('a step undoes and redoes added, removed, edited and moved sparks', () => {
  roundTrip((value) => {
    allocSpark(value, { groupId: HOME, title: toLabel('e'), url: SparkUrl.parse('https://e.example'), thumb: null })
  })
  roundTrip((value) => {
    value.sparks = value.sparks.filter((spark) => spark.title !== 'b')
  })
  roundTrip((value) => {
    const [first] = value.sparks
    if (first) first.title = toLabel('renamed')
  })
  roundTrip((value) => {
    const moved = value.sparks.find((spark) => spark.title === 'a')
    if (moved) moved.groupId = GroupId.parse(1)
    value.sparks = [...value.sparks.filter((spark) => spark !== moved), ...(moved ? [moved] : [])]
  })
})

test('a step undoes and redoes the order of sparks and of groups', () => {
  roundTrip((value) => {
    value.sparks = [value.sparks[1], value.sparks[0], value.sparks[2], value.sparks[3]].filter((spark): spark is Spark => spark !== undefined)
  })
  roundTrip((value) => {
    value.groups.reverse()
    value.sparks = [...value.sparks.slice(2), ...value.sparks.slice(0, 2)]
  })
})

test('a step undoes and redoes added groups and settings', () => {
  roundTrip((value) => {
    allocGroup(value, toLabel('New'))
  })
  roundTrip((value) => {
    value.prefs = { ...value.prefs, columns: 7 }
  })
})

test('a step tells what each side looked like, and only what changed', () => {
  const before = doc()
  const after = structuredClone(before)
  allocSpark(after, { groupId: HOME, title: toLabel('e'), url: SparkUrl.parse('https://e.example'), thumb: null })
  const step = diff(before, after, HOME, GroupId.parse(1))
  assert.ok(step)
  assert.deepEqual(
    step.before.sparks.map(({ id, value }) => [id, value]),
    [[4, null]]
  )
  assert.equal(step.after.sparks[0]?.value?.title, 'e')
  assert.deepEqual(step.before.groups, [])
  assert.deepEqual(step.before.sparkOrders, [{ groupId: HOME, ids: [0, 1] }])
  assert.deepEqual(step.after.sparkOrders, [{ groupId: HOME, ids: [0, 1, 4] }])
  assert.equal(step.before.groupOrder, null)
  assert.equal(step.before.prefs, null)
  assert.deepEqual([step.before.active, step.after.active], [0, 1])
})

test('undo leaves what others changed since then', () => {
  const before = doc()
  const after = structuredClone(before)
  after.groups.reverse()
  after.sparks = [...after.sparks.slice(2), ...after.sparks.slice(0, 2)]
  const step = diff(before, after, HOME, HOME)
  assert.ok(step)
  const now = structuredClone(after)
  const theirs = allocGroup(now, toLabel('Theirs'))
  allocSpark(now, { groupId: HOME, title: toLabel('x'), url: SparkUrl.parse('https://x.example'), thumb: null })
  now.prefs.columns = 6
  applySide(now, step.before)
  assert.deepEqual(groupTitles(now), ['Home', 'Work', 'Theirs'])
  assert.deepEqual(titles(now), ['0:a', '0:b', '0:x', '1:c', '1:d'])
  assert.equal(now.prefs.columns, 6)
  assert.ok(now.groups.some((group) => group.id === theirs.id))
})

test('the sparks of a group are sorted back without touching other groups', () => {
  const before = doc()
  const after = structuredClone(before)
  after.sparks = [after.sparks[1], after.sparks[0], after.sparks[3], after.sparks[2]].filter((spark): spark is Spark => spark !== undefined)
  const step = diff(before, after, HOME, HOME)
  assert.ok(step)
  const partly = structuredClone(after)
  applySide(partly, { ...step.before, sparkOrders: step.before.sparkOrders.filter(({ groupId }) => groupId === HOME) })
  assert.deepEqual(titles(partly), ['0:a', '0:b', '1:d', '1:c'])
})

test('the thumbnails a step holds on to', () => {
  const thumbs: ThumbId[] = [newThumbId(), newThumbId()]
  const before = doc()
  const after = structuredClone(before)
  const [first, second] = after.sparks
  if (first) first.thumb = thumbs[0] ?? null
  if (second) second.thumb = thumbs[1] ?? null
  const step = diff(before, after, HOME, HOME)
  assert.ok(step)
  assert.deepEqual(stepThumbs(step), thumbs)
})

test('a stored step reads back as it was, its settings checked', () => {
  const before = doc()
  const after = structuredClone(before)
  after.prefs = { ...after.prefs, columns: 7 }
  allocSpark(after, { groupId: HOME, title: toLabel('e'), url: SparkUrl.parse('https://e.example'), thumb: null })
  const step = diff(before, after, HOME, HOME)
  assert.deepEqual(parseStep(JSON.parse(JSON.stringify(step))), step)
  assert.ok(step)
  const { prefs: _, ...withoutPrefs } = step.before
  const stored = { before: withoutPrefs, after: { ...step.after, prefs: { columns: 99 } } }
  assert.equal(parseStep(stored)?.after.prefs?.columns, 8)
  assert.equal(parseStep(stored)?.before.prefs, null)
  assert.equal(parseStep('garbage'), null)
  assert.equal(stepKey(3), 'step:3')
})
