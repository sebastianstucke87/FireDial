// The data FireDial works on: branded types, limits and the checks that make them.

import * as z from 'zod/mini'

// Extension pages forbid eval, which zod would otherwise try.
z.config({ jitless: true })

export const LIMITS = {
  groups: 10_000,
  sparksPerGroup: 10_000,
  sparks: 100_000,
  undo: 10_000,
  url: 4_000,
  label: 400,
  backupBytes: 1024 ** 3
} as const

const THEMES = ['light', 'dark', 'system'] as const
const COLORS = ['firedial', 'rose', 'berry', 'violet', 'ocean', 'teal', 'forest', 'custom'] as const
const LAYOUTS = ['wide', 'tiles', 'square', 'list'] as const
export const MIN_COLUMNS = 3
export const MAX_COLUMNS = 8
const DENSITY_STEPS = 5
export const MIN_GROUP_WIDTH = 180 // px
export const MAX_GROUP_WIDTH = 400 // px
const OLD_GROUP_WIDTHS = [196, 236, 296] // px: the width was once a step from 1 to 3

type Theme = (typeof THEMES)[number]
type Color = (typeof COLORS)[number]
type Layout = (typeof LAYOUTS)[number]

const Id = z.int().check(z.nonnegative())
export const SparkId = Id.brand<'SparkId'>()
export const GroupId = Id.brand<'GroupId'>()
export const ThumbId = z.string().check(z.minLength(1)).brand<'ThumbId'>()
export const Label = z.string().check(z.maxLength(LIMITS.label)).brand<'Label'>()
export const SparkUrl = z.string().check(z.minLength(1), z.maxLength(LIMITS.url)).brand<'SparkUrl'>()

export type SparkId = z.infer<typeof SparkId>
export type GroupId = z.infer<typeof GroupId>
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

export const Group = z.object({ id: GroupId, title: z.pipe(z.string(), z.transform(toLabel)) })
export const Spark = z.object({
  id: SparkId,
  groupId: GroupId,
  title: LabelText,
  url: z.pipe(
    z.pipe(
      Text,
      z.transform((url: string) => url.trim())
    ),
    SparkUrl
  ),
  thumb: z.catch(z.nullable(ThumbId), null)
})

export type Group = z.infer<typeof Group>
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
}

// groups in display order; sparks grouped by group, in display order within each.
export interface Doc {
  groups: Group[]
  sparks: Spark[]
  prefs: Prefs
  nextGroupId: number // ids are never reused: undo may bring back any of them
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
  layout: 'wide'
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
export const isGroupId = guard(GroupId)
export const isThumbId = guard(ThumbId)
export const isTheme = guard(z.enum(THEMES))
export const isColor = guard(z.enum(COLORS))
export const isLayout = guard(z.enum(LAYOUTS))

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
  layout: z.catch(z.enum(LAYOUTS), DEFAULT_PREFS.layout)
})

export function normalizePrefs(raw: unknown): Prefs {
  const result = PrefsSchema.safeParse(raw)
  return result.success ? result.data : { ...DEFAULT_PREFS }
}

export function allocGroup(doc: Doc, title: Label): Group {
  const group = { id: GroupId.parse(doc.nextGroupId), title }
  doc.nextGroupId += 1
  doc.groups.push(group)
  return group
}

export function allocSpark(doc: Doc, fields: Omit<Spark, 'id'>): Spark {
  const spark = { id: SparkId.parse(doc.nextSparkId), ...fields }
  doc.nextSparkId += 1
  doc.sparks.push(spark)
  return spark
}

// "New Group #3": one more than the highest number in use.
export function nextGroupName(groups: readonly Group[]): Label {
  const numbers = groups
    .map((group) => /^New Group #(\d+)$/.exec(group.title)?.[1])
    .map(Number)
    .filter(Number.isInteger)
  return toLabel(`New Group #${Math.max(0, ...numbers) + 1}`)
}

// As FireDial comes: nothing in it that a backup would keep.
export function isVanilla(doc: Doc): boolean {
  const {
    groups: [home],
    prefs
  } = emptyDoc()
  return (
    !doc.sparks.length && doc.groups.length === 1 && doc.groups[0]?.title === home?.title && JSON.stringify(normalizePrefs(doc.prefs)) === JSON.stringify(prefs)
  )
}

// Every doc keeps at least one group, and sparks in group order: a spark whose group is gone
// (undo after a change made elsewhere) lands in the first group.
export function canonicalize(doc: Doc): void {
  if (!doc.groups.length) doc.groups.push(allocHome(doc))
  const byGroup = new Map<GroupId, Spark[]>(doc.groups.map((group) => [group.id, []]))
  const first = doc.groups[0]?.id
  for (const spark of doc.sparks) {
    const bucket = byGroup.get(spark.groupId)
    if (bucket) bucket.push(spark)
    else if (first !== undefined) byGroup.get(first)?.push({ ...spark, groupId: first })
  }
  doc.sparks = [...byGroup.values()].flat()
}

export function checkLimits(doc: Doc): void {
  if (doc.groups.length > LIMITS.groups) throw new LimitError(`FireDial holds at most ${LIMITS.groups} groups`)
  if (doc.sparks.length > LIMITS.sparks) throw new LimitError(`FireDial holds at most ${LIMITS.sparks} sparks`)
  const counts = new Map<GroupId, number>()
  for (const { groupId } of doc.sparks) counts.set(groupId, (counts.get(groupId) ?? 0) + 1)
  if (Math.max(0, ...counts.values()) > LIMITS.sparksPerGroup) throw new LimitError(`A group holds at most ${LIMITS.sparksPerGroup} sparks`)
}

function allocHome(doc: Doc): Group {
  const group = { id: GroupId.parse(doc.nextGroupId), title: toLabel('Home') }
  doc.nextGroupId += 1
  return group
}

export const newThumbId = (): ThumbId => ThumbId.parse(crypto.randomUUID())

export function emptyDoc(): Doc {
  return { groups: [{ id: GroupId.parse(0), title: toLabel('Home') }], sparks: [], prefs: { ...DEFAULT_PREFS }, nextGroupId: 1, nextSparkId: 0 }
}
