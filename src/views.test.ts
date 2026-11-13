import assert from 'node:assert/strict'
import { test } from 'node:test'

import { allocView, emptyDoc, LimitError, LIMITS, moveView, SparkId } from './model.ts'
import {
  addTo,
  arrange,
  carries,
  deleteView,
  knownLabels,
  LabelName,
  labelProblem,
  makeView,
  membersOf,
  moveInView,
  newView,
  normalizeOrders,
  removeFrom,
  renameView,
  splitLabels,
  ViewId
} from './model.ts'
import type { Item, Rule, Shelf, View } from './model.ts'

const name = (text: string): LabelName => LabelName.parse(text)

function spark(id: number, title: string, labels: string[] = [], url = `https://${title.toLowerCase()}.example`): Item {
  return { id: SparkId.parse(id), title, url, labels: labels.map(name) }
}

let nextView = 0
function view(title: string, rule: Partial<Record<keyof Rule, string[] | boolean>> = {}): View {
  const made = makeView(ViewId.parse(nextView++), 'normal', name(title))
  const list = (key: 'include' | 'exclude'): LabelName[] => {
    const value = rule[key]
    return Array.isArray(value) ? value.map(name) : []
  }
  made.rule = { all: rule.all === true, include: list('include'), exclude: list('exclude') }
  return made
}

const builtIns = (): View[] => [makeView(ViewId.parse(nextView++), 'all', name('All')), makeView(ViewId.parse(nextView++), 'unlabeled', name('Unlabeled'))]

const titles = (sparks: readonly Item[]): string[] => sparks.map((each) => each.title)

// github and jira are work, streaming and shopping are home; a recipe is in no view. The views
// keep their own order, unless a test sorts them.
function shelf(...views: View[]): Shelf<Item> {
  const all = [...builtIns(), ...views]
  for (const each of all) each.sort = 'manual'
  return {
    views: all,
    sparks: [
      spark(0, 'GitHub', ['github', 'Work']),
      spark(1, 'Jira', ['jira']),
      spark(2, 'Netflix', ['streaming']),
      spark(3, 'Shop', ['shopping', 'Private']),
      spark(4, 'Docs', ['Work', 'docs']),
      spark(5, 'Recipe', ['cooking'])
    ]
  }
}

const shown = (of: Shelf<Item>, title: string): string[] => {
  const found = of.views.find((each) => each.title === title)
  assert.ok(found, title)
  return titles(membersOf(of, found))
}

test('a topic view shows the sparks that carry its title, whatever the case', () => {
  const work = view('work')
  assert.deepEqual(shown(shelf(work), 'work'), ['GitHub', 'Docs'])
})

test('base None shows the sparks with any included label', () => {
  const homeoffice = view('Homeoffice', { include: ['github', 'jira', 'streaming', 'shopping'] })
  assert.deepEqual(shown(shelf(homeoffice), 'Homeoffice'), ['GitHub', 'Jira', 'Netflix', 'Shop'])
})

test('base All without included labels shows everything but the excluded labels', () => {
  const home = view('Home', { all: true, exclude: ['Work', 'private'] })
  assert.deepEqual(shown(shelf(home), 'Home'), ['Jira', 'Netflix', 'Recipe'])
})

test('base All shows only the sparks with every included label, less the excluded ones', () => {
  const workDocs = view('Work docs', { all: true, include: ['work', 'docs'] })
  assert.deepEqual(shown(shelf(workDocs), 'Work docs'), ['Docs'])
  const workOnly = view('Work only', { all: true, include: ['work'], exclude: ['docs'] })
  assert.deepEqual(shown(shelf(workOnly), 'Work only'), ['GitHub'])
})

test('base None without included labels shows only its own sparks', () => {
  assert.deepEqual(shown(shelf(view('Fun', { exclude: ['work'] })), 'Fun'), [])
})

test('a spark put into a view shows there even when the rule leaves it out', () => {
  const home = view('Home', { all: true, exclude: ['work'] })
  const of = shelf(home)
  const github = of.sparks[0]
  assert.ok(github)
  assert.equal(addTo([github], home), 1)
  assert.deepEqual(shown(of, 'Home'), ['GitHub', 'Jira', 'Netflix', 'Shop', 'Recipe'])
})

test('All shows everything, Unlabeled the sparks without any label', () => {
  const of = shelf(view('Work'))
  of.sparks.push(spark(6, 'Blank'))
  assert.deepEqual(shown(of, 'All'), ['GitHub', 'Jira', 'Netflix', 'Shop', 'Docs', 'Recipe', 'Blank'])
  assert.deepEqual(shown(of, 'Unlabeled'), ['Blank'])
})

test('a view sorts by name, address or newest first, and keeps its own order for later', () => {
  const of = shelf()
  const all = of.views[0]
  assert.ok(all)
  of.sparks[2] = spark(2, 'netflix', ['streaming'], 'https://www.aaa.example')
  normalizeOrders(of)
  all.sort = 'name'
  assert.deepEqual(titles(arrange(of, all)), ['Docs', 'GitHub', 'Jira', 'netflix', 'Recipe', 'Shop'])
  all.sort = 'address'
  assert.equal(arrange(of, all)[0]?.title, 'netflix')
  all.sort = 'date'
  assert.deepEqual(titles(arrange(of, all)), ['Recipe', 'Docs', 'Shop', 'netflix', 'Jira', 'GitHub'])
  all.sort = 'manual'
  assert.deepEqual(titles(arrange(of, all)), ['GitHub', 'Jira', 'netflix', 'Shop', 'Docs', 'Recipe'])
})

test('dragging in a sorted view starts its own order from the sorted one', () => {
  const work = view('Work', { include: ['jira'] })
  const of = shelf(work)
  normalizeOrders(of)
  work.sort = 'name'
  moveInView(of, work, [SparkId.parse(1)], SparkId.parse(4), false)
  assert.equal(work.sort, 'manual')
  assert.deepEqual(titles(arrange(of, work)), ['Jira', 'Docs', 'GitHub'])
})

test('dragging a spark the rule shows only reorders it, and moves in other views stay out of All', () => {
  const work = view('Work', { include: ['jira'] })
  const of = shelf(work)
  normalizeOrders(of)
  moveInView(of, work, [SparkId.parse(1)], SparkId.parse(0), false)
  assert.deepEqual(titles(arrange(of, work)), ['Jira', 'GitHub', 'Docs'])
  assert.equal(carries(of.sparks[1] ?? spark(9, 'x'), 'Work'), false)
  assert.deepEqual(titles(of.sparks), ['GitHub', 'Jira', 'Netflix', 'Shop', 'Docs', 'Recipe'])
})

test('dragging in All reorders the sparks themselves', () => {
  const of = shelf()
  const all = of.views[0]
  assert.ok(all)
  normalizeOrders(of)
  moveInView(of, all, [SparkId.parse(5)], SparkId.parse(0), false)
  assert.deepEqual(titles(of.sparks), ['Recipe', 'GitHub', 'Jira', 'Netflix', 'Shop', 'Docs'])
})

test('a view order drops what left and adds what came, at the end', () => {
  const work = view('Work')
  const of = shelf(work)
  normalizeOrders(of)
  moveInView(of, work, [SparkId.parse(4)], SparkId.parse(0), false)
  const [github, jira] = of.sparks
  assert.ok(github && jira)
  removeFrom(work, [github])
  addTo([jira], work)
  normalizeOrders(of)
  assert.deepEqual(titles(arrange(of, work)), ['Docs', 'Jira'])
})

test('removing from a view takes its label and counts the sparks its rule still shows', () => {
  const work = view('Work', { include: ['github'] })
  const of = shelf(work)
  const [github, , , , docs] = of.sparks
  assert.ok(github && docs)
  assert.deepEqual(removeFrom(work, [github, docs]), { changed: 2, stillShown: 1 })
  assert.deepEqual(shown(of, 'Work'), ['GitHub'])
})

test('All and Unlabeled give and take no label', () => {
  const of = shelf()
  const [all, unlabeled] = of.views
  assert.ok(all && unlabeled)
  assert.equal(addTo(of.sparks, all), 0)
  assert.equal(addTo(of.sparks, unlabeled), 0)
  assert.equal(removeFrom(unlabeled, of.sparks).changed, 0)
  assert.deepEqual(deleteView(of, all, true), [])
  assert.equal(of.views.length, 2)
})

test('renaming a view renames its label on sparks and in rules', () => {
  const work = view('Work')
  const morning = view('Morning', { include: ['work'] })
  const of = shelf(work, morning)
  renameView(of, work, ' Job ')
  assert.equal(work.title, 'Job')
  assert.deepEqual(shown(of, 'Job'), ['GitHub', 'Docs'])
  assert.deepEqual(morning.rule.include, ['Job'])
})

test('renaming onto another view title makes them one view', () => {
  const work = view('Work')
  const job = view('Job', { include: ['jira'] })
  const of = shelf(work, job)
  const kept = renameView(of, work, 'job')
  assert.equal(kept, job)
  assert.equal(of.views.includes(work), false)
  assert.deepEqual(shown(of, 'Job'), ['GitHub', 'Jira', 'Docs'])
  assert.deepEqual(of.sparks[4]?.labels, ['Job', 'docs'])
})

test('a new view needs a free title', () => {
  const of = shelf(view('Work'))
  assert.throws(() => newView(of, ViewId.parse(99), 'WORK'), LimitError)
  assert.throws(() => newView(of, ViewId.parse(99), '  '), LimitError)
  assert.equal(newView(of, ViewId.parse(99), 'Trip to Rome').title, 'Trip to Rome')
})

test('deleting a view keeps its label, or takes its sparks along from everywhere', () => {
  const work = view('Work')
  const morning = view('Morning', { include: ['work'] })
  const of = shelf(work, morning)
  deleteView(of, work, false)
  assert.deepEqual(shown(of, 'Morning'), ['GitHub', 'Docs'])
  const job = view('Job', { include: ['jira'] })
  of.views.push(job)
  addTo([of.sparks[0] ?? spark(9, 'x')], job)
  assert.deepEqual(titles(deleteView(of, job, true)), ['GitHub'])
  assert.deepEqual(titles(of.sparks), ['Jira', 'Netflix', 'Shop', 'Docs', 'Recipe'])
})

test('labels are free text, split by commas, each once whatever the case', () => {
  assert.deepEqual(splitLabels(' Trip to  Rome, work,WORK ,, dev '), ['Trip to Rome', 'work', 'dev'])
  assert.equal(labelProblem(''), 'A label needs a name')
  assert.equal(labelProblem('a,b'), 'A label has no comma')
  assert.equal(labelProblem('x'.repeat(LIMITS.label)), null)
  assert.notEqual(labelProblem('x'.repeat(LIMITS.label + 1)), null)
})

test('a spark holds at most 50 labels', () => {
  const full = spark(
    0,
    'Full',
    Array.from({ length: LIMITS.labelsPerSpark }, (_, index) => `l${index}`)
  )
  assert.throws(() => addTo([full], view('More')), LimitError)
  assert.equal(full.labels.length, LIMITS.labelsPerSpark)
})

test('a rule can pick any label in use or any view title, each once, alphabetically', () => {
  assert.deepEqual(knownLabels(shelf(view('Fun'), view('work'))), ['cooking', 'docs', 'Fun', 'github', 'jira', 'Private', 'shopping', 'streaming', 'work'])
})

test('a new view sorts by name, by the address where a spark has no title, whatever the case', () => {
  const fresh = view('Fresh')
  assert.equal(fresh.sort, 'name')
  const of = { views: [fresh], sparks: [spark(0, 'beta', ['Fresh']), spark(1, '', ['Fresh'], 'https://www.Alpha.example'), spark(2, 'Gamma', ['Fresh'])] }
  assert.deepEqual(titles(arrange(of, fresh)), ['', 'beta', 'Gamma'])
})

test('views move before or after another in the sidebar; unknown ids change nothing', () => {
  const doc = { ...emptyDoc(), sparks: [] }
  const [a, b, c] = ['A', 'B', 'C'].map((title) => allocView(doc, title))
  assert.ok(a && b && c)
  const order = (): string[] => doc.views.map((each) => each.title)
  moveView(doc, c.id, a.id, false)
  assert.deepEqual(order(), ['All', 'Unlabeled', 'C', 'A', 'B'])
  moveView(doc, c.id, b.id, true)
  assert.deepEqual(order(), ['All', 'Unlabeled', 'A', 'B', 'C'])
  moveView(doc, a.id, ViewId.parse(0), false)
  assert.deepEqual(order(), ['A', 'All', 'Unlabeled', 'B', 'C'])
  for (const [id, target] of [
    [a.id, a.id],
    [ViewId.parse(99), b.id],
    [b.id, ViewId.parse(99)]
  ] as const)
    moveView(doc, id, target, true)
  assert.deepEqual(order(), ['A', 'All', 'Unlabeled', 'B', 'C'])
})

test('a move onto one of the moving sparks, or before the first one, changes nothing', () => {
  const of = shelf()
  const all = of.views[0]
  assert.ok(all)
  normalizeOrders(of)
  const [github, jira, netflix] = of.sparks
  assert.ok(github && jira && netflix)
  moveInView(of, all, [jira.id, netflix.id], netflix.id, true)
  assert.deepEqual(titles(of.sparks), ['GitHub', 'Jira', 'Netflix', 'Shop', 'Docs', 'Recipe'])
  moveInView(of, all, [jira.id], SparkId.parse(99), false)
  assert.deepEqual(titles(of.sparks), ['GitHub', 'Jira', 'Netflix', 'Shop', 'Docs', 'Recipe'], 'a target it does not show')
  moveInView(of, all, [netflix.id, github.id], github.id, false)
  assert.deepEqual(titles(of.sparks), ['GitHub', 'Jira', 'Netflix', 'Shop', 'Docs', 'Recipe'])
  moveInView(of, all, [github.id], null, false)
  assert.deepEqual(titles(of.sparks), ['Jira', 'Netflix', 'Shop', 'Docs', 'Recipe', 'GitHub'], 'no target: to the end')
  moveInView(of, all, [github.id], jira.id, true)
  assert.deepEqual(titles(of.sparks), ['Jira', 'GitHub', 'Netflix', 'Shop', 'Docs', 'Recipe'], 'after the target')
})

test('All keeps the order of the sparks, whatever its own order said', () => {
  const of = shelf()
  const all = of.views[0]
  assert.ok(all)
  all.order = [SparkId.parse(5), SparkId.parse(4)]
  normalizeOrders(of)
  assert.deepEqual(all.order, [0, 1, 2, 3, 4, 5])
})

test('a view in its own order stays so when dragged, and sorts by address without scheme or www', () => {
  const work = view('Work')
  work.sort = 'manual'
  const of = {
    views: [work],
    sparks: [spark(0, 'b', ['Work'], 'https://www.b.example'), spark(1, 'a', ['Work'], 'https://c.example/www.a'), spark(2, 'c', ['Work'], 'ftp://a.example')]
  }
  normalizeOrders(of)
  work.order = [SparkId.parse(2), SparkId.parse(0), SparkId.parse(1)]
  moveInView(of, work, [SparkId.parse(1)], SparkId.parse(2), false)
  assert.deepEqual(titles(arrange(of, work)), ['a', 'c', 'b'], 'from its own order, not from All')
  work.sort = 'address'
  assert.deepEqual(titles(arrange(of, work)), ['c', 'b', 'a'])
})

test('All and Unlabeled rename without touching labels; a merge keeps the other view', () => {
  const work = view('Work')
  const job = view('Job', { include: ['jira'] })
  const of = shelf(work, job)
  of.sparks.push(spark(6, 'Labeled All', ['All']))
  const [all] = of.views
  assert.ok(all)
  assert.equal(renameView(of, all, 'Everything'), all)
  assert.equal(all.title, 'Everything')
  assert.deepEqual(of.sparks[6]?.labels, ['All'], 'a label called All is just a label')
  assert.equal(renameView(of, job, 'JOB'), job, 'its own title, another case')
  assert.equal(job.title, 'JOB')
  assert.throws(() => renameView(of, work, ' '), { message: 'A label needs a name' })
  assert.throws(() => newView(of, ViewId.parse(98), 'job'), { message: 'There is a view called job already' })
})

test('removing from All or Unlabeled takes nothing and counts every spark as still shown', () => {
  const of = shelf()
  const [all] = of.views
  assert.ok(all)
  assert.deepEqual(removeFrom(all, of.sparks), { changed: 0, stillShown: 6 })
})

test('deleting a view takes only it; without its sparks it returns none', () => {
  const work = view('Work')
  const fun = view('Fun')
  const of = shelf(work, fun)
  assert.deepEqual(deleteView(of, work, false), [])
  assert.deepEqual(
    of.views.map((each) => each.title),
    ['All', 'Unlabeled', 'Fun']
  )
  assert.equal(of.sparks.length, 6)
})

test('a spark over the label limit names it', () => {
  const full = spark(
    0,
    'Full',
    Array.from({ length: LIMITS.labelsPerSpark }, (_, index) => `l${index}`)
  )
  assert.throws(() => addTo([full], view('More')), { message: `A spark has at most ${LIMITS.labelsPerSpark} labels` })
})
