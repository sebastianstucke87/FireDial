import assert from 'node:assert/strict'
import { test } from 'node:test'

import { backupName, exportParts, importSummary, parseBackup, readBackup } from './backup.ts'
import { emptyDoc, GroupId, LimitError, LIMITS, SparkId, ThumbId, toLabel, toSparkUrl } from './model.ts'
import type { Doc } from './model.ts'

function sampleDoc(): Doc {
  const doc = emptyDoc()
  const url = toSparkUrl('https://a.example/')
  assert.ok(url)
  doc.sparks.push({ id: SparkId.parse(0), groupId: GroupId.parse(0), title: toLabel('a'), url, thumb: ThumbId.parse('x') })
  return doc
}

test('an export imports back', () => {
  const doc = sampleDoc()
  const parts = exportParts(doc, new Map([[ThumbId.parse('x'), 'data:image']]))
  const data: unknown = JSON.parse(parts.join(''))
  const parsed = parseBackup(data)
  assert.deepEqual(
    parsed.groups.map((group) => group.title),
    ['Home']
  )
  assert.deepEqual(
    parsed.sparks.map(({ title, url, src }) => [title, url, src]),
    [['a', 'https://a.example/', 'data:image']]
  )
  assert.equal(parsed.skipped, 0)
})

test('#13: cuts long titles, skips long URLs and reports them', () => {
  const parsed = parseBackup({
    format: 'firedial',
    groups: [{ id: 0, title: 'x'.repeat(LIMITS.label + 50) }],
    sparks: [
      { id: 0, groupId: 0, title: 'ok', url: 'https://a.example/' },
      { id: 1, groupId: 0, title: 'too long', url: `https://a.example/${'x'.repeat(LIMITS.url)}` }
    ]
  })
  assert.equal(parsed.groups[0]?.title.length, LIMITS.label)
  assert.equal(parsed.sparks.length, 1)
  assert.equal(parsed.skipped, 1)
})

test('#13: refuses more groups than the limit', () => {
  const groups = Array.from({ length: LIMITS.groups + 1 }, (_, id) => ({ id, title: 'g' }))
  assert.throws(() => parseBackup({ format: 'firedial', groups, sparks: [] }), LimitError)
})

test('refuses files of another format', () => {
  assert.throws(() => parseBackup({ hello: 'world' }), /Unknown file format/)
  assert.throws(() => parseBackup(null), /Unknown file format/)
  for (const text of ['', '{"format":"firedial","sparks":[', '<!doctype html>']) assert.throws(() => readBackup(text), /^Error: Unknown file format$/)
  assert.equal(readBackup(JSON.stringify({ format: 'firedial', groups: [], sparks: [{ groupId: 0, title: 'A', url: 'https://a.example/' }] })).sparks.length, 1)
})

test('a file without sparks is not imported: it would only delete what is there', () => {
  assert.throws(() => parseBackup({ format: 'firedial', groups: [{ id: 0, title: 'Empty' }], sparks: [] }), /no sparks/)
  assert.throws(() => parseBackup({ format: 'firedial', groups: [], sparks: [{ url: '' }] }), /no sparks/)
})

test('backups are named by the local time, automatic ones say so', () => {
  const when = new Date(1999, 11, 31, 23, 59, 59)
  assert.equal(backupName(when, false), 'firedial_1999-12-31_235959.json')
  assert.equal(backupName(when, true), 'firedial_1999-12-31_235959_autobackup.json')
  assert.equal(backupName(new Date(2026, 0, 2, 3, 4, 5), false), 'firedial_2026-01-02_030405.json')
})

test('the import summary counts in the right number', () => {
  assert.equal(importSummary(1, 1, 0), 'Imported 1 group with 1 spark')
  assert.equal(importSummary(3, 292, 0), 'Imported 3 groups with 292 sparks')
  assert.equal(importSummary(2, 5, 1), 'Imported 2 groups with 5 sparks, skipped 1 (URL empty or too long)')
})

test('an export lists every spark, those without a picture with an empty one', () => {
  const doc = sampleDoc()
  const url = toSparkUrl('https://b.example/')
  assert.ok(url)
  doc.sparks.push({ id: SparkId.parse(1), groupId: GroupId.parse(0), title: toLabel('b'), url, thumb: null })
  const parsed = parseBackup(JSON.parse(exportParts(doc, new Map([[ThumbId.parse('x'), 'data:image']])).join('')))
  assert.deepEqual(
    parsed.sparks.map(({ title, src }) => [title, src]),
    [
      ['a', 'data:image'],
      ['b', '']
    ]
  )
})

test('sparks of an unknown group go to the first, and a file without groups gets Home', () => {
  const parsed = parseBackup({
    format: 'firedial',
    groups: [
      { id: 5, title: 'Five' },
      { id: 6, title: 'Six' }
    ],
    sparks: [
      { groupId: 6, title: 'six', url: 'https://a.example/' },
      { groupId: 9, title: 'lost', url: 'https://b.example/' }
    ]
  })
  assert.deepEqual(
    parsed.sparks.map(({ groupKey, src }) => [groupKey, src]),
    [
      [6, ''],
      [5, '']
    ]
  )
  const homeless = parseBackup({ format: 'firedial', groups: [], sparks: [{ groupId: 3, title: 'a', url: 'https://a.example/' }] })
  assert.deepEqual(homeless.groups, [{ key: 0, title: 'Home' }])
  assert.equal(homeless.sparks[0]?.groupKey, 0)
})

test('the limits themselves are allowed, one more is refused with the numbers', () => {
  const spark = { groupId: 0, title: 's', url: 'https://a.example/' }
  const groups = (count: number): { id: number; title: string }[] => Array.from({ length: count }, (_, id) => ({ id, title: 'g' }))
  assert.equal(parseBackup({ format: 'firedial', groups: groups(LIMITS.groups), sparks: [spark] }).groups.length, LIMITS.groups)
  assert.throws(
    () => parseBackup({ format: 'firedial', groups: groups(LIMITS.groups + 1), sparks: [spark] }),
    new RegExp(`The file has ${LIMITS.groups + 1} groups, FireDial holds at most ${LIMITS.groups}`)
  )
  const sparks = (count: number): (typeof spark)[] => Array.from({ length: count }, () => spark)
  assert.equal(parseBackup({ format: 'firedial', groups: groups(1), sparks: sparks(LIMITS.sparks) }).sparks.length, LIMITS.sparks)
  assert.throws(
    () => parseBackup({ format: 'firedial', groups: groups(1), sparks: sparks(LIMITS.sparks + 1) }),
    new RegExp(`The file has ${LIMITS.sparks + 1} sparks, FireDial holds at most ${LIMITS.sparks}`)
  )
})
