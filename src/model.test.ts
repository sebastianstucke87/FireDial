import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  accentOf,
  allocGroup,
  allocSpark,
  canonicalize,
  checkLimits,
  DEFAULT_PREFS,
  emptyDoc,
  GroupId,
  isVanilla,
  LimitError,
  LIMITS,
  nextGroupName,
  normalizePrefs,
  normalizeUrl,
  searchUrl,
  Spark,
  SparkId,
  SparkUrl,
  Text,
  toHexColor,
  toLabel,
  toSparkUrl
} from './model.ts'

test('the search box opens what looks like an address', () => {
  assert.equal(searchUrl('https://a.example/x?y=1'), 'https://a.example/x?y=1')
  assert.equal(searchUrl('about:debugging#/runtime/this-firefox'), 'about:debugging#/runtime/this-firefox')
  assert.equal(searchUrl('file:///C:/a.txt'), 'file:///C:/a.txt')
  assert.equal(searchUrl('example.com'), 'https://example.com')
  assert.equal(searchUrl('  example.com/a/b  '), 'https://example.com/a/b')
  assert.equal(searchUrl('localhost:3000/x'), 'http://localhost:3000/x')
  assert.equal(searchUrl('192.168.1.10:5001'), 'http://192.168.1.10:5001')
})

test('and searches for everything else', () => {
  for (const text of ['', 'firefox', 'how to tie a tie', 'a.example with words', 'word:word', '@engine cats']) assert.equal(searchUrl(text), null, text)
})

test('hex colors can be typed in several ways', () => {
  assert.equal(toHexColor('#4F46E5'), '#4f46e5')
  assert.equal(toHexColor('4f46e5'), '#4f46e5')
  assert.equal(toHexColor('#abc'), '#aabbcc')
  for (const text of ['', '#12', '#12345', '#ggg000', 'red']) assert.equal(toHexColor(text), null, text)
})

test('graphite lives on as the custom color', () => {
  const prefs = normalizePrefs({ color: 'graphite' })
  assert.equal(prefs.color, 'custom')
  assert.equal(prefs.customColor, '#3f3f46')
})

test('settings of an older version are dropped', () => {
  assert.ok(!('previews' in normalizePrefs({ previews: 'fill' })))
})

test('a new FireDial starts with the wide layout', () => {
  assert.equal(normalizePrefs({}).layout, 'wide')
})

test('columns stop at 8', () => {
  assert.equal(normalizePrefs({ columns: 12 }).columns, 8)
})

test('FireDial is vanilla until something in it changed', () => {
  assert.equal(isVanilla(emptyDoc()), true)
  const changes = [
    (doc: ReturnType<typeof emptyDoc>) => {
      doc.prefs.showCounts = false
    },
    (doc: ReturnType<typeof emptyDoc>) => {
      doc.prefs.customColor = '#123456'
    },
    (doc: ReturnType<typeof emptyDoc>) => {
      allocGroup(doc, toLabel('Second'))
    },
    (doc: ReturnType<typeof emptyDoc>) => {
      doc.groups = [{ id: GroupId.parse(5), title: toLabel('Renamed') }]
    },
    (doc: ReturnType<typeof emptyDoc>) => {
      const url = toSparkUrl('https://a.example/')
      if (url) allocSpark(doc, { groupId: GroupId.parse(0), title: toLabel('a'), url, thumb: null })
    }
  ]
  for (const change of changes) {
    const doc = emptyDoc()
    change(doc)
    assert.equal(isVanilla(doc), false)
  }
})

test('the group sidebar width is in pixels, and the old three steps become their widths', () => {
  assert.equal(normalizePrefs({}).groupWidth, 236)
  assert.deepEqual(
    [1, 2, 3].map((step) => normalizePrefs({ groupWidth: step }).groupWidth),
    [196, 236, 296]
  )
  assert.equal(normalizePrefs({ groupWidth: 312.4 }).groupWidth, 312)
  assert.equal(normalizePrefs({ groupWidth: 20 }).groupWidth, 180)
  assert.equal(normalizePrefs({ groupWidth: 5000 }).groupWidth, 400)
  assert.equal(normalizePrefs({ groupWidth: 0 }).groupWidth, 236)
  assert.equal(normalizePrefs({ groupWidth: 'wide' }).groupWidth, 236)
})

test('text from outside: numbers count, labels and addresses are trimmed', () => {
  assert.equal(Text.parse(5), '5')
  assert.equal(Text.parse({}), '')
  assert.equal(toLabel('  a  '), 'a')
  assert.equal(toSparkUrl('  https://a.example/ '), 'https://a.example/')
  assert.equal(Spark.parse({ id: 0, groupId: 0, title: ' a ', url: ' https://a.example/ ' }).url, 'https://a.example/')
  assert.equal(toHexColor(' #ABC '), '#aabbcc')
})

test('an address someone typed gets https:// unless it has a scheme', () => {
  assert.equal(normalizeUrl(' example.com '), 'https://example.com')
  assert.equal(normalizeUrl(' mailto:a@example.com '), 'mailto:a@example.com')
  assert.equal(normalizeUrl('web+app.x-y:z'), 'web+app.x-y:z')
  assert.equal(normalizeUrl('example.com/x:y'), 'https://example.com/x:y')
  assert.equal(normalizeUrl('1a:b'), 'https://1a:b')
})

test('the search box tells addresses from searches exactly', () => {
  assert.equal(searchUrl('http://a b'), null)
  assert.equal(searchUrl('http://example.com'), 'http://example.com')
  assert.equal(searchUrl('example.com/?u=http://x'), 'https://example.com/?u=http://x')
  assert.equal(searchUrl('!!example.com'), null)
  assert.equal(searchUrl('example.com>'), null)
  assert.equal(searchUrl('[::1]:8080'), 'http://[::1]:8080')
  assert.equal(searchUrl('example.com/localhost'), 'https://example.com/localhost')
  assert.equal(searchUrl('192.168.10.10:5001'), 'http://192.168.10.10:5001')
})

test('the default settings, and the accent of each color', () => {
  assert.deepEqual(DEFAULT_PREFS, {
    columns: 5,
    density: 3,
    groupWidth: 236,
    theme: 'system',
    color: 'firedial',
    customColor: '#3f3f46',
    showTitle: true,
    showCounts: true,
    layout: 'wide'
  })
  assert.deepEqual(emptyDoc().prefs, DEFAULT_PREFS)
  const accents = (['firedial', 'rose', 'berry', 'violet', 'ocean', 'teal', 'forest', 'custom'] as const).map((color) => accentOf({ ...DEFAULT_PREFS, color }))
  assert.deepEqual(accents, ['#c2410c', '#be123c', '#a3307a', '#6d28d9', '#1d4ed8', '#0f766e', '#166534', '#3f3f46'])
  assert.deepEqual([normalizePrefs({ showTitle: 'x' }).showTitle, normalizePrefs({ showCounts: 'x' }).showCounts], [true, true])
})

test('new groups and sparks get the next ids', () => {
  const doc = emptyDoc()
  assert.deepEqual([allocGroup(doc, toLabel('a')).id, allocGroup(doc, toLabel('b')).id, doc.nextGroupId], [1, 2, 3])
})

test('a new group is numbered one above the highest "New Group #n"', () => {
  const titles = ['New Group #2', 'x New Group #20', 'New Group #30x', 'New Group #12', 'Other']
  assert.equal(nextGroupName(titles.map((title, id) => ({ id: GroupId.parse(id), title: toLabel(title) }))), 'New Group #13')
})

test('a doc without groups gets Home, and a spark whose group is gone joins the first group', () => {
  const doc = { ...emptyDoc(), groups: [], nextGroupId: 5 }
  allocSpark(doc, { groupId: GroupId.parse(7), title: toLabel('a'), url: SparkUrl.parse('https://a.example/'), thumb: null })
  canonicalize(doc)
  assert.deepEqual(doc.groups, [{ id: 5, title: 'Home' }])
  assert.equal(doc.nextGroupId, 6)
  assert.deepEqual(
    doc.sparks.map((spark) => [spark.groupId, spark.title]),
    [[5, 'a']]
  )
})

test('the limits themselves are allowed, one more is not', () => {
  const doc = emptyDoc()
  const url = SparkUrl.parse('https://a.example/')
  const fill = (groups: number, sparks: number, perGroup: boolean): void => {
    doc.groups = Array.from({ length: groups }, (_, id) => ({ id: GroupId.parse(id), title: toLabel('g') }))
    doc.sparks = Array.from({ length: sparks }, (_, id) => ({
      id: SparkId.parse(id),
      groupId: GroupId.parse(perGroup ? 0 : id % groups),
      title: toLabel('s'),
      url,
      thumb: null
    }))
  }
  fill(LIMITS.groups, 0, false)
  checkLimits(doc)
  fill(LIMITS.groups + 1, 0, false)
  assert.throws(() => checkLimits(doc), new LimitError(`FireDial holds at most ${LIMITS.groups} groups`))
  fill(LIMITS.groups, LIMITS.sparks, false)
  checkLimits(doc)
  fill(LIMITS.groups, LIMITS.sparks + 1, false)
  assert.throws(() => checkLimits(doc), new LimitError(`FireDial holds at most ${LIMITS.sparks} sparks`))
  fill(1, LIMITS.sparksPerGroup, true)
  checkLimits(doc)
  fill(1, LIMITS.sparksPerGroup + 1, true)
  assert.throws(() => checkLimits(doc), new LimitError(`A group holds at most ${LIMITS.sparksPerGroup} sparks`))
})
