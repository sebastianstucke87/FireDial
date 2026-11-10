// Undo steps: only what a change touched, so thousands of them stay small. A step holds both
// sides of the change: the groups and sparks it touched, and the order of the groups it reordered.

import * as z from 'zod/mini'

import { canonicalize, Group, GroupId, listOf, normalizePrefs, Spark, SparkId } from './model.ts'
import type { Doc, Prefs, ThumbId } from './model.ts'

interface SparkChange {
  id: SparkId
  value: Spark | null // null: the spark doesn't exist on this side
}

interface GroupChange {
  id: GroupId
  value: Group | null
}

interface SparkOrder {
  groupId: GroupId
  ids: SparkId[]
}

interface Side {
  sparks: SparkChange[]
  groups: GroupChange[]
  sparkOrders: SparkOrder[]
  groupOrder: GroupId[] | null
  prefs: Prefs | null
  active: GroupId | null // the group to show after going to this side
}

export interface Step {
  before: Side
  after: Side
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

function sparkIdsByGroup(doc: Doc): Map<GroupId, SparkId[]> {
  const byGroup = new Map<GroupId, SparkId[]>()
  for (const { id, groupId } of doc.sparks) {
    const ids = byGroup.get(groupId)
    if (ids) ids.push(id)
    else byGroup.set(groupId, [id])
  }
  return byGroup
}

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

// null when nothing changed.
export function diff(before: Doc, after: Doc, activeBefore: GroupId | null, activeAfter: GroupId | null): Step | null {
  const sparks = changes(before.sparks, after.sparks)
  const groups = changes(before.groups, after.groups)
  const groupIds = new Set([...before.groups, ...after.groups].map((group) => group.id))
  const [idsBefore, idsAfter] = [sparkIdsByGroup(before), sparkIdsByGroup(after)]
  const orders = [...groupIds]
    .map((groupId) => ({ groupId, from: idsBefore.get(groupId) ?? [], to: idsAfter.get(groupId) ?? [] }))
    .filter(({ from, to }) => !same(from, to))
  const groupOrderChanged = !same(
    before.groups.map((group) => group.id),
    after.groups.map((group) => group.id)
  )
  const prefsChanged = !same(before.prefs, after.prefs)
  if (!sparks.length && !groups.length && !orders.length && !groupOrderChanged && !prefsChanged) return null
  return {
    before: {
      sparks: sparks.map(({ id, before: value }) => ({ id, value })),
      groups: groups.map(({ id, before: value }) => ({ id, value })),
      sparkOrders: orders.map(({ groupId, from }) => ({ groupId, ids: from })),
      groupOrder: groupOrderChanged ? before.groups.map((group) => group.id) : null,
      prefs: prefsChanged ? before.prefs : null,
      active: activeBefore
    },
    after: {
      sparks: sparks.map(({ id, after: value }) => ({ id, value })),
      groups: groups.map(({ id, after: value }) => ({ id, value })),
      sparkOrders: orders.map(({ groupId, to }) => ({ groupId, ids: to })),
      groupOrder: groupOrderChanged ? after.groups.map((group) => group.id) : null,
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

function ranked<Id>(ids: readonly Id[]): (id: Id) => number {
  const rank = new Map(ids.map((id, index) => [id, index]))
  return (id) => rank.get(id) ?? ids.length
}

// Sets the doc to this side of a step. Things changed by others since then stay as they are.
export function applySide(doc: Doc, side: Side): void {
  doc.sparks = applyChanges(doc.sparks, side.sparks)
  doc.groups = applyChanges(doc.groups, side.groups)
  if (side.prefs) doc.prefs = side.prefs
  if (side.groupOrder) {
    const rank = ranked(side.groupOrder)
    doc.groups.sort((a, b) => rank(a.id) - rank(b.id))
  }
  canonicalize(doc)
  for (const { groupId, ids } of side.sparkOrders) {
    const rank = ranked(ids)
    const sorted = doc.sparks.filter((spark) => spark.groupId === groupId).sort((a, b) => rank(a.id) - rank(b.id))
    let next = 0
    doc.sparks = doc.sparks.map((spark) => (spark.groupId === groupId ? (sorted[next++] ?? spark) : spark))
  }
}

export function stepThumbs(step: Step): ThumbId[] {
  return [...step.before.sparks, ...step.after.sparks].map(({ value }) => value?.thumb).filter((thumb) => thumb != null)
}

const SideSchema = z.object({
  sparks: listOf(z.object({ id: SparkId, value: z.catch(z.nullable(Spark), null) })),
  groups: listOf(z.object({ id: GroupId, value: z.catch(z.nullable(Group), null) })),
  sparkOrders: listOf(z.object({ groupId: GroupId, ids: listOf(SparkId) })),
  groupOrder: z.catch(z.nullable(listOf(GroupId)), null),
  prefs: z.pipe(
    z.optional(z.unknown()),
    z.transform((prefs: unknown) => (prefs ? normalizePrefs(prefs) : null))
  ),
  active: z.catch(z.nullable(GroupId), null)
})

const StepSchema = z.catch(z.nullable(z.object({ before: SideSchema, after: SideSchema })), null)

export const parseStep = (raw: unknown): Step | null => StepSchema.parse(raw)

export const stepKey = (index: number): string => `step:${index}`
