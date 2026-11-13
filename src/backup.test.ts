import assert from 'node:assert/strict'
import { test } from 'node:test'

import { backupName, exportParts, importSummary, parseBackup, readBackup } from './backup.ts'
import { addTo, allocView, emptyDoc, LabelName, LimitError, LIMITS, SparkId, ThumbId, toLabel, toSparkUrl } from './model.ts'
import type { Doc } from './model.ts'

function sampleDoc(): Doc {
  const doc = emptyDoc()
  const url = toSparkUrl('https://a.example/')
  assert.ok(url)
  const work = allocView(doc, 'Work')
  work.rule.include = [LabelName.parse('Docs')]
  work.sort = 'name'
  doc.sparks.push({ id: SparkId.parse(0), title: toLabel('a'), url, thumb: ThumbId.parse('x'), labels: [LabelName.parse('Trip to Rome')] })
  addTo(doc.sparks, work)
  return doc
}

const file = (views: unknown[], sparks: unknown[]): unknown => ({ format: 'firedial', views, sparks })

test('an export imports back, views with their rule, sort and order', () => {
  const doc = sampleDoc()
  doc.views[2]?.order.push(SparkId.parse(0))
  const parts = exportParts(doc, new Map([[ThumbId.parse('x'), 'data:image']]))
  const parsed = parseBackup(JSON.parse(parts.join('')))
  assert.deepEqual(
    parsed.views.map(({ kind, title, sort, rule, order }) => [kind, title, sort, rule.include, order]),
    [
      ['all', 'All', 'name', [], []],
      ['unlabeled', 'Unlabeled', 'name', [], []],
      ['normal', 'Work', 'name', ['Docs'], [0]]
    ]
  )
  assert.deepEqual(
    parsed.sparks.map(({ key, title, url, src, labels }) => [key, title, url, src, labels]),
    [[0, 'a', 'https://a.example/', 'data:image', ['Trip to Rome', 'Work']]]
  )
  assert.equal(parsed.skipped, 0)
})

test('a backup keeps the valid labels, each once, and drops the others', () => {
  const parsed = parseBackup(
    file(
      [],
      [
        { id: 0, title: 'a', url: 'https://a.example/', labels: ['Docs', 'docs', 'two words', 'a,b', '', 42] },
        { id: 1, title: 'b', url: 'https://b.example/' },
        { id: 2, title: 'c', url: 'https://c.example/', labels: 'docs' }
      ]
    )
  )
  assert.deepEqual(
    parsed.sparks.map((spark) => spark.labels),
    [['Docs', 'two words'], [], []]
  )
})

test('broken views are left out, missing parts get defaults', () => {
  const parsed = parseBackup(
    file(
      [{ kind: 'normal', title: 'Fine' }, { kind: 'normal', title: '   ' }, 'x', { kind: 'all', title: 'Every', sort: 'up' }],
      [{ id: 0, title: 'a', url: 'https://a.example/' }]
    )
  )
  assert.deepEqual(
    parsed.views.map(({ kind, title, sort, order }) => [kind, title, sort, order]),
    [
      ['normal', 'Fine', 'name', []],
      ['normal', 'View', 'name', []],
      ['all', 'Every', 'name', []]
    ]
  )
})

test('#13: cuts long titles, skips long URLs and reports them', () => {
  const parsed = parseBackup(
    file(
      [],
      [
        { id: 0, title: 'x'.repeat(LIMITS.label + 50), url: 'https://a.example/' },
        { id: 1, title: 'too long', url: `https://a.example/${'x'.repeat(LIMITS.url)}` }
      ]
    )
  )
  assert.equal(parsed.sparks[0]?.title.length, LIMITS.label)
  assert.equal(parsed.sparks.length, 1)
  assert.equal(parsed.skipped, 1)
})

test('refuses files of another format, and old ones with groups', () => {
  assert.throws(() => parseBackup({ hello: 'world' }), /Unknown file format/)
  assert.throws(() => parseBackup(null), /Unknown file format/)
  assert.throws(() => parseBackup({ format: 'firedial', groups: [], sparks: [{ groupId: 0, title: 'A', url: 'https://a.example/' }] }), /Unknown file format/)
  for (const text of ['', '{"format":"firedial","sparks":[', '<!doctype html>']) assert.throws(() => readBackup(text), /^Error: Unknown file format$/)
  assert.equal(readBackup(JSON.stringify(file([], [{ title: 'A', url: 'https://a.example/' }]))).sparks.length, 1)
})

test('a file without sparks is not imported: it would only delete what is there', () => {
  assert.throws(() => parseBackup(file([{ kind: 'normal', title: 'Empty' }], [])), /no sparks/)
  assert.throws(() => parseBackup(file([], [{ url: '' }])), /no sparks/)
})

test('backups are named by the local time, automatic ones say so', () => {
  const when = new Date(1999, 11, 31, 23, 59, 59)
  assert.equal(backupName(when, false), 'firedial_1999-12-31_235959.json')
  assert.equal(backupName(when, true), 'firedial_1999-12-31_235959_autobackup.json')
  assert.equal(backupName(new Date(2026, 0, 2, 3, 4, 5), false), 'firedial_2026-01-02_030405.json')
})

test('the import summary counts in the right number', () => {
  assert.equal(importSummary(1, 1, 0), 'Imported 1 view with 1 spark')
  assert.equal(importSummary(3, 292, 0), 'Imported 3 views with 292 sparks')
  assert.equal(importSummary(2, 5, 1), 'Imported 2 views with 5 sparks, skipped 1 (URL empty or too long)')
})

test('an export lists every spark, those without a picture with an empty one', () => {
  const doc = sampleDoc()
  const url = toSparkUrl('https://b.example/')
  assert.ok(url)
  doc.sparks.push({ id: SparkId.parse(1), title: toLabel('b'), url, thumb: null, labels: [] })
  const parsed = parseBackup(JSON.parse(exportParts(doc, new Map([[ThumbId.parse('x'), 'data:image']])).join('')))
  assert.deepEqual(
    parsed.sparks.map(({ title, src }) => [title, src]),
    [
      ['a', 'data:image'],
      ['b', '']
    ]
  )
})

test('the limits themselves are allowed, one more is refused with the numbers', () => {
  const spark = { title: 's', url: 'https://a.example/' }
  const views = (count: number): unknown[] => Array.from({ length: count }, (_, id) => ({ kind: 'normal', title: `v${id}` }))
  assert.equal(parseBackup(file(views(LIMITS.views), [spark])).views.length, LIMITS.views)
  assert.throws(
    () => parseBackup(file(views(LIMITS.views + 1), [spark])),
    new RegExp(`The file has ${LIMITS.views + 1} views, FireDial holds at most ${LIMITS.views}`)
  )
  const sparks = (count: number): (typeof spark)[] => Array.from({ length: count }, () => spark)
  assert.equal(parseBackup(file([], sparks(LIMITS.sparks))).sparks.length, LIMITS.sparks)
  assert.throws(
    () => parseBackup(file([], sparks(LIMITS.sparks + 1))),
    new RegExp(`The file has ${LIMITS.sparks + 1} sparks, FireDial holds at most ${LIMITS.sparks}`)
  )
  assert.throws(() => parseBackup(file([], sparks(LIMITS.sparks + 1))), LimitError)
})

test('an export has no version number: an import goes by what is in the file', () => {
  const exported: unknown = JSON.parse(exportParts(sampleDoc(), new Map()).join(''))
  assert.ok(exported !== null && typeof exported === 'object' && !('version' in exported))
  assert.equal(parseBackup({ format: 'firedial', version: 99, views: [], sparks: [{ title: 'a', url: 'https://a.example/' }] }).sparks.length, 1)
})
