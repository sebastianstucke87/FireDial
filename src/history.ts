// Undo steps: only what a change touched, so thousands of them stay small. A step holds both
// sides of the change: the views and sparks it touched, and the order of views or sparks if it
// changed. A view's own order is part of the view.

import * as z from 'zod/mini'

import { canonicalize, listOf, normalizePrefs, Spark, SparkId, View, ViewId } from './model.ts'
import type { Doc, Prefs, ThumbId } from './model.ts'

interface SparkChange {
  id: SparkId
  value: Spark | null // null: the spark doesn't exist on this side
}

interface ViewChange {
  id: ViewId
  value: View | null
}

interface Side {
  sparks: SparkChange[]
  views: ViewChange[]
  sparkOrder: SparkId[] | null
  viewOrder: ViewId[] | null
  prefs: Prefs | null
  active: ViewId | null // the view to show after going to this side
}

export interface Step {
  before: Side
  after: Side
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

function changes<Item extends { id: number }>(from: readonly Item[], to: readonly Item[]): { id: Item['id']; before: Item | null; after: Item | null }[] {
  const old = new Map<Item['id'], Item>(from.map((item) => [item.id, item]))
  const result: { id: Item['id']; before: Item | null; after: Item | null }[] = []
  for (const item of to) {
    const previous = old.get(item.id)
    if (!previous || !same(previous, item)) result.push({ id: item.id, before: previous ?? null, after: item })
    old.delete(item.id)
  }
  for (const item of old.values()) result.push({ id: item.id, before: item, after: null })
  return result
}

const ids = (items: readonly { id: number }[]): number[] => items.map((item) => item.id)

// null when nothing changed.
export function diff(before: Doc, after: Doc, activeBefore: ViewId | null, activeAfter: ViewId | null): Step | null {
  const sparks = changes(before.sparks, after.sparks)
  const views = changes(before.views, after.views)
  const sparkOrderChanged = !same(ids(before.sparks), ids(after.sparks))
  const viewOrderChanged = !same(ids(before.views), ids(after.views))
  const prefsChanged = !same(before.prefs, after.prefs)
  if (!sparks.length && !views.length && !sparkOrderChanged && !viewOrderChanged && !prefsChanged) return null
  return {
    before: {
      sparks: sparks.map(({ id, before: value }) => ({ id, value })),
      views: views.map(({ id, before: value }) => ({ id, value })),
      sparkOrder: sparkOrderChanged ? before.sparks.map((spark) => spark.id) : null,
      viewOrder: viewOrderChanged ? before.views.map((view) => view.id) : null,
      prefs: prefsChanged ? before.prefs : null,
      active: activeBefore
    },
    after: {
      sparks: sparks.map(({ id, after: value }) => ({ id, value })),
      views: views.map(({ id, after: value }) => ({ id, value })),
      sparkOrder: sparkOrderChanged ? after.sparks.map((spark) => spark.id) : null,
      viewOrder: viewOrderChanged ? after.views.map((view) => view.id) : null,
      prefs: prefsChanged ? after.prefs : null,
      active: activeAfter
    }
  }
}

function applyChanges<Item extends { id: number }>(items: readonly Item[], list: readonly { id: Item['id']; value: Item | null }[]): Item[] {
  const byId = new Map<Item['id'], Item>(items.map((item) => [item.id, item]))
  for (const { id, value } of list) {
    if (value) byId.set(id, value)
    else byId.delete(id)
  }
  return [...byId.values()]
}

// Items in the order given; those it doesn't know keep their place among themselves, at the end.
function sortBy(items: { id: number }[], order: readonly number[]): void {
  const rank = new Map(order.map((id, index) => [id, index]))
  items.sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length))
}

// Sets the doc to this side of a step. Things changed by others since then stay as they are.
export function applySide(doc: Doc, side: Side): void {
  doc.sparks = applyChanges(doc.sparks, side.sparks)
  doc.views = applyChanges(doc.views, side.views)
  if (side.prefs) doc.prefs = side.prefs
  if (side.viewOrder) sortBy(doc.views, side.viewOrder)
  if (side.sparkOrder) sortBy(doc.sparks, side.sparkOrder)
  canonicalize(doc)
}

export function stepThumbs(step: Step): ThumbId[] {
  return [...step.before.sparks, ...step.after.sparks].map(({ value }) => value?.thumb).filter((thumb) => thumb != null)
}

const SideSchema = z.object({
  sparks: listOf(z.object({ id: SparkId, value: z.catch(z.nullable(Spark), null) })),
  views: listOf(z.object({ id: ViewId, value: z.catch(z.nullable(View), null) })),
  sparkOrder: z.catch(z.nullable(listOf(SparkId)), null),
  viewOrder: z.catch(z.nullable(listOf(ViewId)), null),
  prefs: z.pipe(
    z.optional(z.unknown()),
    z.transform((prefs: unknown) => (prefs ? normalizePrefs(prefs) : null))
  ),
  active: z.catch(z.nullable(ViewId), null)
})

const StepSchema = z.catch(z.nullable(z.object({ before: SideSchema, after: SideSchema })), null)

export const parseStep = (raw: unknown): Step | null => StepSchema.parse(raw)

export const stepKey = (index: number): string => `step:${index}`
