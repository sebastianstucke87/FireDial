// The one store behind every tab and the background script. Everything lives in storage.local:
// the doc, the undo history and the images. Each change is a read-modify-write under a lock, so
// tabs can't overwrite each other, and each tab follows the others through storage.onChanged.
//
// An image never changes once stored: a new image gets a new ThumbId and sparks point at it.
// That makes undoing an image change free; images nothing points at any more are collected later.

import * as z from 'zod/mini'

import { applySide, diff, parseStep, stepKey, stepThumbs } from './history.ts'
import type { Step } from './history.ts'
import {
  allocGroup,
  allocSpark,
  canonicalize,
  checkLimits,
  emptyDoc,
  Group,
  GroupId,
  isThumbId,
  LIMITS,
  newThumbId,
  normalizePrefs,
  Spark,
  Text,
  ThumbId,
  validItems
} from './model.ts'
import type { Doc, Label, Prefs, SparkUrl } from './model.ts'

export interface KeyValue {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
  onChanged(listener: (keys: ReadonlySet<string>) => void): void
}

export type Lock = <T>(task: () => Promise<T>) => Promise<T>

// Stryker disable all: Firefox's storage and locks, only there in the e2e tests
export const browserKeyValue: KeyValue = {
  async get(keys) {
    const data: Record<string, unknown> = await browser.storage.local.get(keys)
    return data
  },
  set: (items) => browser.storage.local.set(items),
  remove: (keys) => browser.storage.local.remove(keys),
  onChanged(listener) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') listener(new Set(Object.keys(changes)))
    })
  }
}

const LOCK_TIMEOUT = 10_000 // ms: a stuck tab must not block the others for good

export const webLock: Lock = (task) => navigator.locks.request('firedial', { signal: AbortSignal.timeout(LOCK_TIMEOUT) }, task)
// Stryker restore all

export const thumbKey = (id: ThumbId): string => `thumb:${id}`

const SCHEMA = 3
const STATE_KEYS = ['schema', 'rev', 'groups', 'sparks', 'prefs', 'nextIds', 'history']
const THUMB_CHUNK = 200 // images per storage write on import

interface HistoryMeta {
  first: number // oldest step
  cursor: number // steps before this one are undoable, from here on redoable
  end: number
}

interface State {
  doc: Doc
  rev: number
  history: HistoryMeta
}

export interface ImportedGroup {
  key: number
  title: Label
}

export interface ImportedSpark {
  groupKey: number
  title: Label
  url: SparkUrl
  src: string
}

export interface ImportedData {
  groups: ImportedGroup[]
  sparks: ImportedSpark[]
  prefs: Prefs
}

export interface CommitOptions {
  thumbs?: Readonly<Record<ThumbId, string>> // new images the change refers to
  active?: GroupId // the group shown while changing, for undo to return to
  unchecked?: boolean // from outside FireDial: over-limit data is kept rather than refused
  ifRevision?: number // only if the store is still at this revision
}

// A change: edits the doc it gets, and may return the group to show afterwards.
export type Mutate = (doc: Doc) => GroupId | undefined

const Position = z.pipe(z.coerce.number(), z.int())
const HistoryMetaSchema = z.catch(z.object({ first: Position, cursor: Position, end: Position }), { first: 0, cursor: 0, end: 0 })
const Revision = z.catch(z.coerce.number(), 0)
const NextIds = z.catch(z.object({ group: Revision, spark: Revision }), { group: 0, spark: 0 })
const List = z.catch(z.array(z.unknown()), [])
const Colors = z.catch(z.record(z.string(), z.unknown()), {})

function parseState(data: Record<string, unknown>): State {
  const fallback = emptyDoc()
  const ids = NextIds.parse(data['nextIds'])
  const doc: Doc = {
    groups: validItems(Group, List.parse(data['groups'])),
    sparks: validItems(Spark, List.parse(data['sparks'])),
    prefs: normalizePrefs(data['prefs']),
    nextGroupId: ids.group || fallback.nextGroupId,
    nextSparkId: ids.spark || fallback.nextSparkId
  }
  canonicalize(doc)
  return { doc, rev: Revision.parse(data['rev']), history: HistoryMetaSchema.parse(data['history']) }
}

const docItems = (doc: Doc): Record<string, unknown> => ({
  groups: doc.groups,
  sparks: doc.sparks,
  prefs: doc.prefs,
  nextIds: { group: doc.nextGroupId, spark: doc.nextSparkId }
})

// The parts of the doc a step touched: the others stay out of the write and out of onChanged.
function changedItems(doc: Doc, { after }: Step): Record<string, unknown> {
  const { groups, sparks, prefs, nextIds } = docItems(doc)
  return {
    ...(after.groups.length || after.groupOrder ? { groups } : {}),
    ...(after.sparks.length || after.sparkOrders.length ? { sparks } : {}),
    ...(after.prefs ? { prefs } : {}),
    nextIds
  }
}

const stepKeys = (from: number, to: number): string[] => Array.from({ length: Math.max(0, to - from) }, (_, index) => stepKey(from + index))
const parseThumbIndex = (raw: unknown): ThumbId[] => validItems(ThumbId, List.parse(raw))

export class Store {
  doc: Doc = emptyDoc()
  private rev = 0
  private history: HistoryMeta = { first: 0, cursor: 0, end: 0 }
  private readonly kv: KeyValue
  private readonly lock: Lock

  constructor(kv: KeyValue, lock: Lock) {
    this.kv = kv
    this.lock = lock
  }

  get revision(): number {
    return this.rev
  }

  get canUndo(): boolean {
    return this.history.cursor > this.history.first
  }

  get canRedo(): boolean {
    return this.history.cursor < this.history.end
  }

  private adopt(state: State): void {
    this.doc = state.doc
    this.rev = state.rev
    this.history = state.history
  }

  private async read(): Promise<State> {
    return parseState(await this.kv.get(STATE_KEYS))
  }

  async load(): Promise<void> {
    const data = await this.kv.get(STATE_KEYS)
    if (data['schema'] === SCHEMA) {
      this.adopt(parseState(data))
      return
    }
    await this.lock(() => this.firstStart())
    this.adopt(await this.read())
  }

  // Calls back when another tab or the background changed something; refresh() then fetches it.
  watch(listener: () => void): void {
    this.kv.onChanged((keys) => {
      if (keys.has('rev')) listener()
    })
  }

  async refresh(): Promise<boolean> {
    const state = await this.read()
    if (state.rev === this.rev) return false
    this.adopt(state)
    return true
  }

  private async firstStart(): Promise<void> {
    const { schema } = await this.kv.get('schema')
    if (schema === SCHEMA) return
    await this.kv.set({ ...docItems(emptyDoc()), schema: SCHEMA, rev: 1, history: { first: 0, cursor: 0, end: 0 }, thumbIndex: [] })
  }

  // false when ifRevision didn't match and nothing was done.
  commit(mutate: Mutate, options: CommitOptions = {}): Promise<boolean> {
    return this.lock(async () => {
      const state = await this.read()
      if (options.ifRevision !== undefined && options.ifRevision !== state.rev) return false
      const after = structuredClone(state.doc)
      const activeAfter = mutate(after) ?? options.active ?? null
      canonicalize(after)
      if (!options.unchecked) checkLimits(after)
      const step = diff(state.doc, after, options.active ?? null, activeAfter)
      if (!step) {
        this.adopt(state)
        return true
      }
      const { first, cursor } = state.history
      const overflow = cursor + 1 - first > LIMITS.undo
      const history = { first: overflow ? first + 1 : first, cursor: cursor + 1, end: cursor + 1 }
      const thumbs = Object.entries(options.thumbs ?? {})
      const items: Record<string, unknown> = { ...changedItems(after, step), rev: state.rev + 1, history, [stepKey(cursor)]: step }
      for (const [id, src] of thumbs) items[`thumb:${id}`] = src
      if (thumbs.length) {
        const { thumbIndex } = await this.kv.get('thumbIndex')
        items['thumbIndex'] = [...parseThumbIndex(thumbIndex), ...thumbs.map(([id]) => id)]
      }
      await this.kv.set(items)
      const dropped = [...stepKeys(cursor + 1, state.history.end), ...(overflow ? [stepKey(first)] : [])]
      if (dropped.length) await this.kv.remove(dropped)
      this.adopt({ doc: after, rev: state.rev + 1, history })
      return true
    })
  }

  // Both return the group to show, if the step knows one.
  undo(): Promise<GroupId | null> {
    return this.travel(-1)
  }

  redo(): Promise<GroupId | null> {
    return this.travel(1)
  }

  private travel(direction: -1 | 1): Promise<GroupId | null> {
    return this.lock(async () => {
      const state = await this.read()
      const { first, cursor, end } = state.history
      const index = direction < 0 ? cursor - 1 : cursor
      if (index < first || index >= end) {
        this.adopt(state)
        return null
      }
      const key = stepKey(index)
      const step = parseStep((await this.kv.get(key))[key])
      const history = { first, cursor: cursor + direction, end }
      const side = step?.[direction < 0 ? 'before' : 'after']
      if (side) applySide(state.doc, side)
      await this.kv.set({ ...(step ? changedItems(state.doc, step) : {}), rev: state.rev + 1, history })
      this.adopt({ doc: state.doc, rev: state.rev + 1, history })
      return side?.active ?? null
    })
  }

  // Import: replaces all data and can't be undone. Ids carry on from the old doc, so nothing
  // that still refers to an old id (another tab, the bookmark map) can mix them up.
  replaceAll(data: ImportedData): Promise<GroupId> {
    return this.lock(async () => {
      const state = await this.read()
      const { thumbIndex } = await this.kv.get('thumbIndex')
      const doc: Doc = { groups: [], sparks: [], prefs: data.prefs, nextGroupId: state.doc.nextGroupId, nextSparkId: state.doc.nextSparkId }
      const groupIds = new Map(data.groups.map((group) => [group.key, allocGroup(doc, group.title).id]))
      const thumbs = new Map<ThumbId, string>()
      for (const spark of data.sparks) {
        const groupId = groupIds.get(spark.groupKey) ?? doc.groups[0]?.id
        if (groupId === undefined) continue
        const thumb = spark.src ? newThumbId() : null
        if (thumb) thumbs.set(thumb, spark.src)
        allocSpark(doc, { groupId, title: spark.title, url: spark.url, thumb })
      }
      canonicalize(doc)
      checkLimits(doc)
      const entries = [...thumbs]
      for (let start = 0; start < entries.length; start += THUMB_CHUNK) {
        await this.kv.set(Object.fromEntries(entries.slice(start, start + THUMB_CHUNK).map(([id, src]) => [thumbKey(id), src])))
      }
      const history = { first: 0, cursor: 0, end: 0 }
      await this.kv.set({ ...docItems(doc), rev: state.rev + 1, history, thumbIndex: [...thumbs.keys()] })
      await this.kv.remove(['thumbColors', ...stepKeys(state.history.first, state.history.end), ...parseThumbIndex(thumbIndex).map(thumbKey)])
      this.adopt({ doc, rev: state.rev + 1, history })
      return doc.groups[0]?.id ?? GroupId.parse(0)
    })
  }

  async thumbs(ids: readonly ThumbId[]): Promise<Map<ThumbId, string>> {
    if (!ids.length) return new Map()
    const stored = await this.kv.get(ids.map(thumbKey))
    return new Map(ids.map((id) => [id, Text.parse(stored[thumbKey(id)])]))
  }

  // Main colors of the images, '' for an image without one. Worked out where an image is shown:
  // an image never changes, so neither does its color, and losing an entry only costs a new look.
  async colors(): Promise<Map<ThumbId, string>> {
    const { thumbColors } = await this.kv.get('thumbColors')
    const colors = new Map<ThumbId, string>()
    for (const [id, color] of Object.entries(Colors.parse(thumbColors))) {
      if (isThumbId(id)) colors.set(id, Text.parse(color))
    }
    return colors
  }

  saveColors(colors: ReadonlyMap<ThumbId, string>): Promise<void> {
    return this.kv.set({ thumbColors: Object.fromEntries(colors) })
  }

  // Removes images that neither the doc nor the undo history can reach any more.
  collectGarbage(): Promise<number> {
    return this.lock(async () => {
      const state = await this.read()
      const { thumbIndex } = await this.kv.get('thumbIndex')
      const live = new Set(state.doc.sparks.map((spark) => spark.thumb))
      const keys = stepKeys(state.history.first, state.history.end)
      const stored = keys.length ? await this.kv.get(keys) : {}
      for (const key of keys) {
        const step: Step | null = parseStep(stored[key])
        if (step) stepThumbs(step).forEach((thumb) => live.add(thumb))
      }
      const index = parseThumbIndex(thumbIndex)
      const dead = index.filter((id) => !live.has(id))
      if (dead.length) {
        await this.kv.set({ thumbIndex: index.filter((id) => live.has(id)) })
        await this.kv.remove(dead.map(thumbKey))
        const colors = await this.colors()
        dead.forEach((id) => colors.delete(id))
        await this.saveColors(colors)
      }
      return dead.length
    })
  }
}
