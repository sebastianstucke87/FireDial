import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  accentOf,
  addLabels,
  allocSpark,
  allocView,
  canonicalize,
  checkLimits,
  DEFAULT_PREFS,
  emptyDoc,
  isVanilla,
  labelProblem,
  LimitError,
  LIMITS,
  makeView,
  nextViewName,
  normalizePrefs,
  normalizeUrl,
  removeLabels,
  searchUrl,
  Spark,
  SparkId,
  SparkUrl,
  Text,
  toHexColor,
  toLabel,
  toLabelName,
  toSparkUrl,
  View,
  ViewId
} from './model.ts'
import type { Doc, LabelName } from './model.ts'

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
      allocView(doc, 'Second')
    },
    (doc: ReturnType<typeof emptyDoc>) => {
      const [all] = doc.views
      if (all) all.sort = 'date'
    },
    (doc: ReturnType<typeof emptyDoc>) => {
      const url = toSparkUrl('https://a.example/')
      if (url) allocSpark(doc, { title: toLabel('a'), url, thumb: null })
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
  assert.equal(Spark.parse({ id: 0, title: ' a ', url: ' https://a.example/ ' }).url, 'https://a.example/')
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
    layout: 'wide',
    showLabels: true,
    showBuiltIn: true,
    labelColor: 'monochrome'
  })
  assert.deepEqual(emptyDoc().prefs, DEFAULT_PREFS)
  const accents = (['firedial', 'rose', 'berry', 'violet', 'ocean', 'teal', 'forest', 'custom'] as const).map((color) => accentOf({ ...DEFAULT_PREFS, color }))
  assert.deepEqual(accents, ['#c2410c', '#be123c', '#a3307a', '#6d28d9', '#1d4ed8', '#0f766e', '#166534', '#3f3f46'])
  assert.deepEqual([normalizePrefs({ showTitle: 'x' }).showTitle, normalizePrefs({ showCounts: 'x' }).showCounts], [true, true])
})

test('new views and sparks get the next ids', () => {
  const doc = emptyDoc()
  assert.deepEqual([allocView(doc, 'a').id, allocView(doc, 'b').id, doc.nextViewId], [2, 3, 4])
})

test('a new view is numbered one above the highest "New View #n"', () => {
  const titles = ['New View #2', 'x New View #20', 'New View #30x', 'New View #12', 'Other']
  const views = titles.flatMap((title, id) => {
    const name = toLabelName(title)
    return name ? [makeView(ViewId.parse(id), 'normal', name)] : []
  })
  assert.equal(nextViewName(views), 'New View #13')
})

test('a doc always has All and Unlabeled once, and each normal title once', () => {
  const doc: Doc = { ...emptyDoc(), views: [], nextViewId: 5 }
  canonicalize(doc)
  assert.deepEqual(
    doc.views.map((view) => [view.id, view.kind, view.title]),
    [
      [6, 'all', 'All'],
      [5, 'unlabeled', 'Unlabeled']
    ]
  )
  const work = toLabelName('Work')
  assert.ok(work)
  doc.views.push(makeView(ViewId.parse(9), 'normal', work), makeView(ViewId.parse(10), 'normal', work), makeView(ViewId.parse(11), 'all', work))
  canonicalize(doc)
  assert.deepEqual(
    doc.views.map((view) => view.id),
    [6, 5, 9]
  )
})

test('the limits themselves are allowed, one more is not', () => {
  const doc = emptyDoc()
  const url = SparkUrl.parse('https://a.example/')
  const fill = (views: number, sparks: number): void => {
    doc.views = Array.from({ length: views }, (_, id) => makeView(ViewId.parse(id), 'normal', name(`v${id}`)))
    doc.sparks = Array.from({ length: sparks }, (_, id) => ({ id: SparkId.parse(id), title: toLabel('s'), url, thumb: null, labels: [] }))
  }
  fill(LIMITS.views, 0)
  checkLimits(doc)
  fill(LIMITS.views + 1, 0)
  assert.throws(() => checkLimits(doc), new LimitError(`FireDial holds at most ${LIMITS.views} views`))
  fill(1, LIMITS.sparks)
  checkLimits(doc)
  fill(1, LIMITS.sparks + 1)
  assert.throws(() => checkLimits(doc), new LimitError(`FireDial holds at most ${LIMITS.sparks} sparks`))
})

function name(text: string): LabelName {
  const label = toLabelName(text)
  assert.ok(label, text)
  return label
}

const sparkWith = (id: number, ...labels: unknown[]): Spark => Spark.parse({ id, title: 's', url: 'https://a.example/', thumb: null, labels })

test('a label keeps its case and spaces, tidied', () => {
  assert.equal(toLabelName('  Trip   to Rome '), 'Trip to Rome')
  assert.equal(toLabelName('#docs:api'), '#docs:api')
})

test('a label holds its limits exactly', () => {
  assert.equal(labelProblem('x'.repeat(LIMITS.label)), null)
  assert.match(labelProblem('x'.repeat(LIMITS.label + 1)) ?? '', /at most 400 characters/)
  assert.equal(labelProblem('äöü'), null, 'characters, not bytes')
  for (const text of ['', '   ']) assert.equal(labelProblem(text), 'A label needs a name', text)
  assert.equal(labelProblem('a,b'), 'A label has no comma')
})

test('a spark keeps each valid label once whatever the case, at most 50', () => {
  assert.deepEqual(sparkWith(0, 'docs', 'Docs', 'two words', '', 7, 'a,b').labels, ['docs', 'two words'])
  const many = Array.from({ length: LIMITS.labelsPerSpark + 1 }, (_, index) => `label${index}`)
  assert.equal(sparkWith(0, ...many).labels.length, LIMITS.labelsPerSpark)
  assert.deepEqual(Spark.parse({ id: 0, title: 's', url: 'https://a.example/' }).labels, [], 'sparks from before labels')
  assert.deepEqual(Spark.parse({ id: 0, title: 's', url: 'https://a.example/', labels: 'docs' }).labels, [])
})

test('adding and removing on a selection counts only the sparks that changed', () => {
  const sparks = [sparkWith(0, 'docs'), sparkWith(1), sparkWith(2, 'docs api')]
  assert.equal(addLabels(sparks, [name('Docs')]), 2)
  assert.equal(addLabels(sparks, [name('docs')]), 0)
  assert.equal(removeLabels(sparks, ['DOCS']), 3)
  assert.deepEqual(
    sparks.map((spark) => spark.labels),
    [[], [], ['docs api']]
  )
  assert.equal(removeLabels(sparks, ['docs']), 0)
})

test('adding to a full spark changes no spark at all', () => {
  const full = Array.from({ length: LIMITS.labelsPerSpark }, (_, index) => `label${index}`)
  const sparks = [sparkWith(0), sparkWith(1, ...full)]
  assert.throws(() => addLabels(sparks, [name('more')]), LimitError)
  assert.deepEqual(sparks[0]?.labels, [])
  assert.equal(addLabels(sparks, [name('label0')]), 1, 'one it has already fits')
})

test('label settings fall back to their defaults', () => {
  assert.equal(normalizePrefs({}).showLabels, true)
  assert.equal(normalizePrefs({}).showBuiltIn, true)
  assert.equal(normalizePrefs({ showBuiltIn: false }).showBuiltIn, false)
  assert.equal(normalizePrefs({ labelColor: 'colorful' }).labelColor, 'colorful')
  assert.equal(normalizePrefs({ labelColor: 'rainbow' }).labelColor, DEFAULT_PREFS.labelColor)
})

test('All and Unlabeled get back their own rules; Unsorted from an older FireDial is Unlabeled', () => {
  const doc = emptyDoc()
  const word = toLabelName('x')
  assert.ok(word)
  for (const view of doc.views) view.rule = { all: false, include: [word], exclude: [word] }
  canonicalize(doc)
  assert.deepEqual(
    doc.views.map((view) => view.rule),
    [
      { all: true, include: [], exclude: [] },
      { all: false, include: [], exclude: [] }
    ]
  )
  assert.equal(View.parse({ id: 3, kind: 'unsorted', title: 'Unsorted' }).kind, 'unlabeled')
  assert.equal(View.parse({ id: 3, kind: 'odd', title: 'Odd' }).kind, 'normal')
})

test('local addresses get http, with the whole IP address', () => {
  assert.equal(searchUrl('10.0.0.12:8080'), 'http://10.0.0.12:8080')
  assert.equal(searchUrl('1.2.3.example'), 'https://1.2.3.example')
})
