// The data FireDial works on: branded types, limits and the checks that make them.

import * as z from 'zod/mini'

// Extension pages forbid eval, which zod would otherwise try.
z.config({ jitless: true })

export const LIMITS = {
  views: 10_000,
  sparks: 100_000,
  undo: 10_000,
  url: 4_000,
  label: 400,
  backupBytes: 1024 ** 3,
  labelsPerSpark: 50
} as const

const THEMES = ['light', 'dark', 'system'] as const
const COLORS = ['firedial', 'rose', 'berry', 'violet', 'ocean', 'teal', 'forest', 'custom'] as const
const LAYOUTS = ['wide', 'tiles', 'square', 'list'] as const
const LABEL_COLORS = ['monochrome', 'solid', 'colorful'] as const
export const MIN_COLUMNS = 3
export const MAX_COLUMNS = 8
const DENSITY_STEPS = 5
export const MIN_GROUP_WIDTH = 180 // px
export const MAX_GROUP_WIDTH = 400 // px
const OLD_GROUP_WIDTHS = [196, 236, 296] // px: the width was once a step from 1 to 3

type Theme = (typeof THEMES)[number]
type Color = (typeof COLORS)[number]
type Layout = (typeof LAYOUTS)[number]
type LabelColor = (typeof LABEL_COLORS)[number]

const Id = z.int().check(z.nonnegative())
export const SparkId = Id.brand<'SparkId'>()
export const ViewId = Id.brand<'ViewId'>()
export const ThumbId = z.string().check(z.minLength(1)).brand<'ThumbId'>()
export const Label = z.string().check(z.maxLength(LIMITS.label)).brand<'Label'>()
export const SparkUrl = z.string().check(z.minLength(1), z.maxLength(LIMITS.url)).brand<'SparkUrl'>()

export type SparkId = z.infer<typeof SparkId>
export type ViewId = z.infer<typeof ViewId>
export type ThumbId = z.infer<typeof ThumbId>
export type Label = z.infer<typeof Label>
export type SparkUrl = z.infer<typeof SparkUrl>

// Text from outside: a number counts, anything else is empty.
export const Text = z.catch(
  z.union([
    z.string(),
    z.pipe(
      z.number(),
      z.transform((value: number) => String(value))
    )
  ]),
  ''
)

export const toLabel = (text: string): Label => Label.parse(text.trim().slice(0, LIMITS.label))

export const LabelText = z.pipe(Text, z.transform(toLabel))

// A label as people write it: free text, spaces and capitals stay. Case doesn't tell two labels
// apart. A label exists only while a spark carries it or a view is called by it.
export const LabelName = z.string().brand<'LabelName'>()
export type LabelName = z.infer<typeof LabelName>

const SEPARATOR = ','

const tidy = (text: string): string => text.trim().replace(/\s+/g, ' ')
export const labelKey = (name: string): string => tidy(name).toLocaleLowerCase()
export const sameLabel = (a: string, b: string): boolean => labelKey(a) === labelKey(b)

// What's wrong with a label as typed, in words for the user; null when it's fine.
export function labelProblem(text: string): string | null {
  const name = tidy(text)
  if (!name) return 'A label needs a name'
  if (name.includes(SEPARATOR)) return 'A label has no comma'
  if (name.length > LIMITS.label) return `A label has at most ${LIMITS.label} characters`
  return null
}

export const toLabelName = (text: string): LabelName | null => (labelProblem(text) ? null : LabelName.parse(tidy(text)))

// Each label once, as first written.
function onceEach(names: readonly LabelName[]): LabelName[] {
  const byKey = new Map<string, LabelName>()
  for (const name of names) if (!byKey.has(labelKey(name))) byKey.set(labelKey(name), name)
  return [...byKey.values()]
}

// Several labels typed at once: a comma separates them.
export const splitLabels = (text: string): LabelName[] => onceEach(text.split(SEPARATOR).flatMap((part) => toLabelName(part) ?? []))

// The valid labels, each once, at most as many as a spark holds.
export const toLabelNames = (items: readonly unknown[]): LabelName[] =>
  onceEach(items.flatMap((item) => (typeof item === 'string' ? (toLabelName(item) ?? []) : []))).slice(0, LIMITS.labelsPerSpark)

const SORTS = ['manual', 'name', 'address', 'date'] as const
const KINDS = ['all', 'unlabeled', 'normal'] as const
export type Sort = (typeof SORTS)[number]
type Kind = (typeof KINDS)[number]

const Labels = z.catch(
  z.pipe(
    z.array(z.unknown()),
    z.transform((items: unknown[]) => toLabelNames(items))
  ),
  []
)

// all: the base. With it a spark needs every included label, without it any one of them.
const RuleSchema = z.object({ all: z.catch(z.boolean(), false), include: Labels, exclude: Labels })
export type Rule = z.infer<typeof RuleSchema>
const noRule = (): Rule => ({ all: false, include: [], exclude: [] })

export const View = z.object({
  id: ViewId,
  kind: z.catch(
    z.pipe(
      z.transform((kind: unknown) => (kind === 'unsorted' ? 'unlabeled' : kind)),
      z.enum(KINDS)
    ),
    'normal'
  ), // Unlabeled was once Unsorted
  title: z.pipe(
    Text,
    z.transform((text: string) => toLabelName(text) ?? LabelName.parse('View'))
  ),
  sort: z.catch(z.enum(SORTS), 'name'),
  order: z.catch(z.array(SparkId), []), // the view's own order, kept while it's sorted otherwise
  rule: z.catch(RuleSchema, noRule())
})
export type View = z.infer<typeof View>

export const Spark = z.object({
  id: SparkId,
  title: LabelText,
  url: z.pipe(
    z.pipe(
      Text,
      z.transform((url: string) => url.trim())
    ),
    SparkUrl
  ),
  thumb: z.catch(z.nullable(ThumbId), null),
  labels: z.catch(
    z.pipe(
      z.array(z.unknown()),
      z.transform((items: unknown[]) => toLabelNames(items))
    ),
    []
  )
})

export type Spark = z.infer<typeof Spark>

export interface Prefs {
  columns: number
  density: number
  groupWidth: number // px
  theme: Theme
  color: Color
  customColor: string // #rrggbb, kept while another color is chosen
  showTitle: boolean
  showCounts: boolean
  layout: Layout
  showLabels: boolean // chips on the sparks
  showBuiltIn: boolean // All and Unlabeled in the sidebar
  labelColor: LabelColor
}

// views in sidebar order; sparks in All's own order.
export interface Doc {
  views: View[]
  sparks: Spark[]
  prefs: Prefs
  nextViewId: number // ids are never reused: undo may bring back any of them
  nextSparkId: number
}

export const DEFAULT_PREFS: Prefs = {
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
}

// The same colors as data-color in newtab.css: the background script has no stylesheet.
const COLOR_VALUES: Readonly<Record<Exclude<Color, 'custom'>, string>> = {
  firedial: '#c2410c',
  rose: '#be123c',
  berry: '#a3307a',
  violet: '#6d28d9',
  ocean: '#1d4ed8',
  teal: '#0f766e',
  forest: '#166534'
}

export const accentOf = (prefs: Prefs): string => (prefs.color === 'custom' ? prefs.customColor : COLOR_VALUES[prefs.color])

// A change that would go over a limit. The message is shown to the user.
export class LimitError extends Error {}

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

const guard =
  <S extends z.ZodMiniType>(schema: S) =>
  (value: unknown): value is z.output<S> =>
    schema.safeParse(value).success
export const isSparkId = guard(SparkId)
export const isViewId = guard(ViewId)
export const isThumbId = guard(ThumbId)
export const isTheme = guard(z.enum(THEMES))
export const isColor = guard(z.enum(COLORS))
export const isLayout = guard(z.enum(LAYOUTS))
export const isLabelColor = guard(z.enum(LABEL_COLORS))

// The items of a list that are valid; the others are left out.
export const validItems = <S extends z.ZodMiniType>(schema: S, items: readonly unknown[]): z.output<S>[] =>
  items.flatMap((item) => {
    const result = schema.safeParse(item)
    return result.success ? [result.data] : []
  })

export const listOf = <S extends z.ZodMiniType>(schema: S) =>
  z.pipe(
    z.array(z.unknown()),
    z.transform((items: unknown[]) => validItems(schema, items))
  )

export function toSparkUrl(text: string): SparkUrl | null {
  const result = SparkUrl.safeParse(text.trim())
  return result.success ? result.data : null
}

export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
}

// #rrggbb from what someone typed: with or without the #, three or six digits.
export function toHexColor(text: string): string | null {
  const digits = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim())?.[1]?.toLowerCase()
  if (!digits) return null
  return `#${digits.length === 3 ? digits.replace(/./g, '$&$&') : digits}`
}

// What the search box opens instead of searching for. A web address without a scheme gets
// https://, one on the local network http://.
export function searchUrl(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  if (/^(https?|ftp|file|about):/i.test(trimmed)) return trimmed
  if (!/^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+|\[[0-9a-f:]+\])(:\d+)?([/?#]\S*)?$/i.test(trimmed)) return null
  return /^(localhost|\d+\.\d+\.\d+\.\d+|\[)/i.test(trimmed) ? `http://${trimmed}` : `https://${trimmed}`
}

const step = (fallback: number, min: number, max: number) =>
  z.catch(
    z.pipe(
      z.coerce.number(),
      z.transform((value: number) => clamp(Math.round(value) || fallback, min, max))
    ),
    fallback
  )

const PrefsSchema = z.object({
  columns: step(DEFAULT_PREFS.columns, MIN_COLUMNS, MAX_COLUMNS),
  density: step(DEFAULT_PREFS.density, 1, DENSITY_STEPS),
  groupWidth: z.catch(
    z.pipe(
      z.coerce.number(),
      z.transform((value: number) =>
        clamp(Math.round(OLD_GROUP_WIDTHS[Math.round(value) - 1] ?? value) || DEFAULT_PREFS.groupWidth, MIN_GROUP_WIDTH, MAX_GROUP_WIDTH)
      )
    ),
    DEFAULT_PREFS.groupWidth
  ),
  theme: z.catch(z.enum(THEMES), DEFAULT_PREFS.theme),
  color: z.catch(
    z.pipe(
      z.transform((color: unknown) => (color === 'graphite' ? 'custom' : color)),
      z.enum(COLORS)
    ),
    DEFAULT_PREFS.color
  ), // graphite is now the custom color's default
  customColor: z.pipe(
    Text,
    z.transform((text: string) => toHexColor(text) ?? DEFAULT_PREFS.customColor)
  ),
  showTitle: z.catch(z.boolean(), true),
  showCounts: z.catch(z.boolean(), true),
  layout: z.catch(z.enum(LAYOUTS), DEFAULT_PREFS.layout),
  showLabels: z.catch(z.boolean(), DEFAULT_PREFS.showLabels),
  showBuiltIn: z.catch(z.boolean(), DEFAULT_PREFS.showBuiltIn),
  labelColor: z.catch(z.enum(LABEL_COLORS), DEFAULT_PREFS.labelColor)
})

export function normalizePrefs(raw: unknown): Prefs {
  const result = PrefsSchema.safeParse(raw)
  return result.success ? result.data : { ...DEFAULT_PREFS }
}

// Views: what the sidebar lists. A view shows the sparks that carry its own label (its title),
// plus those its rule picks by their labels. All and Unlabeled are views with a rule of their own.
// Rules look at labels only, never at other views, so views can't nest or loop.

export interface Item {
  id: SparkId
  title: string
  url: string
  labels: LabelName[]
}

export interface Shelf<S extends Item> {
  views: View[]
  sparks: S[] // in All's own order
}

const ALL_TITLE = LabelName.parse('All')
const UNLABELED_TITLE = LabelName.parse('Unlabeled')

export const carries = (spark: Item, name: string): boolean => spark.labels.some((label) => sameLabel(label, name))

export function makeView(id: ViewId, kind: Kind, title: LabelName): View {
  return { id, kind, title, sort: 'name', order: [], rule: kind === 'all' ? { ...noRule(), all: true } : noRule() }
}

// Own sparks always show, whatever the rule says. Base All: the sparks with every included label,
// so all of them when none is; base None: those with any of them. An excluded label takes a spark out.
function inNormal(spark: Item, view: View): boolean {
  if (carries(spark, view.title)) return true
  const { all, include, exclude } = view.rule
  const has = (name: LabelName): boolean => carries(spark, name)
  return (all ? include.every(has) : include.some(has)) && !exclude.some(has)
}

function shows(view: View, spark: Item): boolean {
  if (view.kind === 'all') return true
  if (view.kind === 'unlabeled') return !spark.labels.length
  return inNormal(spark, view)
}

// The sparks a view shows, in All's order.
export const membersOf = <S extends Item>(shelf: Shelf<S>, view: View): S[] => shelf.sparks.filter((spark) => shows(view, spark))

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

// A to Z, whatever the case.
export const compareLabels = (a: string, b: string): number => collator.compare(a, b)

// What an address sorts by: no scheme, no www.
const addressKey = (url: string): string => url.replace(/^[a-z][a-z0-9+.-]*:\/*/i, '').replace(/^www\./i, '')

// A spark without a title shows its address instead, and sorts by it too.
const shownName = (spark: Item): string => spark.title || addressKey(spark.url)

// The sparks a view shows, in its order: its own one, or its sort with the newest first by date.
export function arrange<S extends Item>(shelf: Shelf<S>, view: View): S[] {
  const members = membersOf(shelf, view)
  const byId = (a: S, b: S): number => a.id - b.id
  switch (view.sort) {
    case 'name':
      return members.sort((a, b) => collator.compare(shownName(a), shownName(b)) || byId(a, b))
    case 'address':
      return members.sort((a, b) => collator.compare(addressKey(a.url), addressKey(b.url)) || byId(a, b))
    case 'date':
      return members.sort((a, b) => byId(b, a))
    case 'manual':
      break
  }
  const rank = new Map(view.order.map((id, index) => [id, index]))
  return members.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
}

// Each view's own order holds exactly what it shows: what left drops out, what's new goes to the
// end, in All's order. All's own order is the order of the sparks.
export function normalizeOrders<S extends Item>(shelf: Shelf<S>): void {
  for (const view of shelf.views) {
    if (view.kind === 'all') {
      view.order = shelf.sparks.map((spark) => spark.id)
      continue
    }
    const members = new Set(membersOf(shelf, view).map((spark) => spark.id))
    const kept = view.order.filter((id) => members.delete(id))
    view.order = [...kept, ...shelf.sparks.filter((spark) => members.has(spark.id)).map((spark) => spark.id)]
  }
}

// Dragging in a sorted view: its order starts from what's shown, then it keeps its own order.
function toManual<S extends Item>(shelf: Shelf<S>, view: View): void {
  if (view.sort === 'manual') return
  view.order = arrange(shelf, view).map((spark) => spark.id)
  view.sort = 'manual'
}

// Puts the sparks before or after the target in the view's own order, in their order there;
// without a target, at the end. In All this is the order of the sparks themselves.
export function moveInView<S extends Item>(shelf: Shelf<S>, view: View, ids: readonly SparkId[], target: SparkId | null, after: boolean): void {
  toManual(shelf, view)
  const moving = new Set(ids)
  if (target !== null && moving.has(target)) return
  const rest = view.order.filter((id) => !moving.has(id))
  const at = target === null ? rest.length : rest.indexOf(target) + (after ? 1 : 0)
  if (target !== null && at < (after ? 1 : 0)) return
  rest.splice(at, 0, ...view.order.filter((id) => moving.has(id)))
  view.order = rest
  if (view.kind === 'all') {
    const byId = new Map(shelf.sparks.map((spark) => [spark.id, spark]))
    shelf.sparks = rest.flatMap((id) => byId.get(id) ?? [])
  }
}

// Sets each spark's labels to what change makes of them; the number of sparks that changed.
function relabel(sparks: readonly Item[], change: (labels: LabelName[]) => LabelName[]): number {
  const next = sparks.map((spark) => onceEach(change(spark.labels)))
  if (next.some((labels) => labels.length > LIMITS.labelsPerSpark)) throw new LimitError(`A spark has at most ${LIMITS.labelsPerSpark} labels`)
  let changed = 0
  sparks.forEach((spark, index) => {
    const labels = next[index] ?? spark.labels
    if (labels.length === spark.labels.length && labels.every((label, at) => label === spark.labels[at])) return
    spark.labels = labels
    changed += 1
  })
  return changed
}

export const addLabels = (sparks: readonly Item[], names: readonly LabelName[]): number => relabel(sparks, (labels) => [...labels, ...names])

export const removeLabels = (sparks: readonly Item[], names: readonly string[]): number =>
  relabel(sparks, (labels) => labels.filter((label) => !names.some((name) => sameLabel(label, name))))

// Adding to a view gives its own label. All and Unlabeled have none: nothing changes.
export const addTo = (sparks: readonly Item[], view: View): number => (view.kind === 'normal' ? addLabels(sparks, [view.title]) : 0)

// Takes the view's own label away; the sparks its rule still shows stay, and are counted.
export function removeFrom(view: View, sparks: readonly Item[]): { changed: number; stillShown: number } {
  if (view.kind !== 'normal') return { changed: 0, stillShown: sparks.length }
  const changed = removeLabels(sparks, [view.title])
  return { changed, stillShown: sparks.filter((spark) => shows(view, spark)).length }
}

const normalViews = (views: readonly View[]): View[] => views.filter((view) => view.kind === 'normal')

export const viewTitled = (views: readonly View[], title: string): View | undefined => normalViews(views).find((view) => sameLabel(view.title, title))

// The labels in use on sparks or as a view's title, each once, alphabetically: what a rule can pick.
export const knownLabels = (shelf: Shelf<Item>): LabelName[] =>
  onceEach([...normalViews(shelf.views).map((view) => view.title), ...shelf.sparks.flatMap((spark) => spark.labels)]).sort(compareLabels)

const renameIn = (names: readonly LabelName[], from: string, to: LabelName): LabelName[] => onceEach(names.map((name) => (sameLabel(name, from) ? to : name)))

// A label gets a new name on every spark and in every rule. Where the new name is in use, the two
// become one.
function renameLabel<S extends Item>(shelf: Shelf<S>, from: string, to: LabelName): void {
  relabel(shelf.sparks, (labels) => renameIn(labels, from, to))
  for (const view of shelf.views) {
    const { include, exclude } = view.rule
    view.rule = { ...view.rule, include: renameIn(include, from, to), exclude: renameIn(exclude, from, to) }
  }
}

const titleOf = (text: string): LabelName => {
  const title = toLabelName(text)
  if (!title) throw new LimitError(labelProblem(text) ?? 'A view needs a name')
  return title
}

// Renames a view and its label. A title another view has makes the two one view: that one stays,
// with its rule and order. The view that's left.
export function renameView<S extends Item>(shelf: Shelf<S>, view: View, text: string): View {
  const title = titleOf(text)
  if (view.kind !== 'normal') {
    view.title = title
    return view
  }
  const other = viewTitled(shelf.views, title)
  const target = other && other !== view ? other : view
  renameLabel(shelf, view.title, target === view ? title : target.title)
  if (target === view) view.title = title
  else shelf.views = shelf.views.filter((each) => each !== view)
  return target
}

// A new normal view, at the end; an error when the title is taken.
export function newView<S extends Item>(shelf: Shelf<S>, id: ViewId, text: string): View {
  const title = titleOf(text)
  if (viewTitled(shelf.views, title)) throw new LimitError(`There is a view called ${title} already`)
  const view = makeView(id, 'normal', title)
  shelf.views.push(view)
  return view
}

// The view goes, its label stays on the sparks, so rules that use it keep working. With its
// sparks, those that carry its label go too, from every view.
export function deleteView<S extends Item>(shelf: Shelf<S>, view: View, withSparks: boolean): S[] {
  if (view.kind !== 'normal') return []
  shelf.views = shelf.views.filter((each) => each !== view)
  if (!withSparks) return []
  const gone = shelf.sparks.filter((spark) => carries(spark, view.title))
  shelf.sparks = shelf.sparks.filter((spark) => !carries(spark, view.title))
  return gone
}

// Moves a view before or after another one in the sidebar.
export function moveView(doc: Doc, id: ViewId, target: ViewId, after: boolean): void {
  const view = doc.views.find((each) => each.id === id)
  if (!view || id === target) return
  const rest = doc.views.filter((each) => each !== view)
  const at = rest.findIndex((each) => each.id === target)
  if (at < 0) return
  rest.splice(after ? at + 1 : at, 0, view)
  doc.views = rest
}

export function allocView(doc: Doc, text: string): View {
  const view = newView(doc, ViewId.parse(doc.nextViewId), text)
  doc.nextViewId += 1
  return view
}

export function allocSpark(doc: Doc, fields: Omit<Spark, 'id' | 'labels'> & { labels?: LabelName[] }): Spark {
  const spark = { id: SparkId.parse(doc.nextSparkId), labels: [], ...fields }
  doc.nextSparkId += 1
  doc.sparks.push(spark)
  return spark
}

// "New View #3": one more than the highest number in use.
export function nextViewName(views: readonly View[]): string {
  const numbers = views
    .map((view) => /^New View #(\d+)$/.exec(view.title)?.[1])
    .map(Number)
    .filter(Number.isInteger)
  return `New View #${Math.max(0, ...numbers) + 1}`
}

// As FireDial comes: nothing in it that a backup would keep.
export function isVanilla(doc: Doc): boolean {
  const fresh = emptyDoc()
  const shape = (each: Doc): string => JSON.stringify(each.views.map(({ kind, title, sort, rule }) => ({ kind, title, sort, rule })))
  return !doc.sparks.length && shape(doc) === shape(fresh) && JSON.stringify(normalizePrefs(doc.prefs)) === JSON.stringify(fresh.prefs)
}

// Every doc has All and Unlabeled once each, and normal views with titles of their own: what
// undo or sync bring in otherwise is put right. Then each view's order follows what it shows.
export function canonicalize(doc: Doc): void {
  const seen = new Set<string>()
  doc.views = doc.views.filter((view) => {
    const key = view.kind === 'normal' ? `normal:${labelKey(view.title)}` : view.kind
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  for (const [kind, title] of [
    ['unlabeled', UNLABELED_TITLE],
    ['all', ALL_TITLE]
  ] as const) {
    if (seen.has(kind)) continue
    doc.views.unshift(makeView(ViewId.parse(doc.nextViewId), kind, title))
    doc.nextViewId += 1
  }
  for (const view of doc.views) if (view.kind !== 'normal') view.rule = view.kind === 'all' ? { ...noRule(), all: true } : noRule()
  normalizeOrders(doc)
}

export function checkLimits(doc: Doc): void {
  if (doc.views.length > LIMITS.views) throw new LimitError(`FireDial holds at most ${LIMITS.views} views`)
  if (doc.sparks.length > LIMITS.sparks) throw new LimitError(`FireDial holds at most ${LIMITS.sparks} sparks`)
}

export const newThumbId = (): ThumbId => ThumbId.parse(crypto.randomUUID())

export function emptyDoc(): Doc {
  return {
    views: [makeView(ViewId.parse(0), 'all', ALL_TITLE), makeView(ViewId.parse(1), 'unlabeled', UNLABELED_TITLE)],
    sparks: [],
    prefs: { ...DEFAULT_PREFS },
    nextViewId: 2,
    nextSparkId: 0
  }
}
