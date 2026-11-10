// Backup files.

import * as z from 'zod/mini'

import { LabelText, LimitError, LIMITS, listOf, normalizePrefs, plural, Text, toLabel, toSparkUrl } from './model.ts'
import type { Doc, ThumbId } from './model.ts'
import type { ImportedData, ImportedGroup, ImportedSpark } from './store.ts'

interface Parsed extends ImportedData {
  skipped: number // sparks left out because their URL is too long or empty
}

const twoDigits = (value: number): string => String(value).padStart(2, '0')

// firedial_1999-12-31_235959.json, in local time. auto: made before an import or a delete.
export function backupName(now: Date, auto: boolean): string {
  const date = `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(twoDigits).join('')
  return `firedial_${date}_${time}${auto ? '_autobackup' : ''}.json`
}

export function importSummary(groups: number, sparks: number, skipped: number): string {
  return `Imported ${plural(groups, 'group')} with ${plural(sparks, 'spark')}${skipped ? `, skipped ${skipped} (URL empty or too long)` : ''}`
}

// In parts, so the file may get bigger than a single string can.
export function exportParts(doc: Doc, images: ReadonlyMap<ThumbId, string>): string[] {
  const { format, version, prefs, groups } = { format: 'firedial', version: 1, prefs: doc.prefs, groups: doc.groups }
  const sparks = doc.sparks.map((spark, index) => {
    const { thumb, ...fields } = spark
    return `${index ? ',' : ''}${JSON.stringify({ ...fields, thumb: thumb ? (images.get(thumb) ?? '') : '' })}`
  })
  return [
    `{"format":${JSON.stringify(format)},"version":${version},"prefs":${JSON.stringify(prefs)},"groups":${JSON.stringify(groups)},"sparks":[`,
    ...sparks,
    ']}'
  ]
}

const Key = z.catch(z.coerce.number(), Number.NaN)

const BackupFile = z.object({
  format: z.literal('firedial'),
  groups: listOf(z.object({ id: Key, title: LabelText })),
  sparks: listOf(z.object({ groupId: Key, title: LabelText, url: Text, thumb: z.catch(z.string(), '') })),
  prefs: z.optional(z.unknown())
})

// A file's text: one that isn't even JSON gets the same answer as any other unknown file.
export function readBackup(text: string): Parsed {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Unknown file format')
  }
  return parseBackup(data)
}

// Over-long titles are cut, sparks with an over-long URL left out.
export function parseBackup(data: unknown): Parsed {
  const file = BackupFile.safeParse(data)
  if (!file.success) throw new Error('Unknown file format')
  const raw = file.data
  let groups: ImportedGroup[] = raw.groups.map(({ id, title }) => ({ key: id, title }))
  if (!groups.length) groups = [{ key: 0, title: toLabel('Home') }]
  const known = new Set(groups.map((group) => group.key))
  const firstKey = groups[0]?.key ?? 0
  const sparks: ImportedSpark[] = []
  for (const { groupId, title, url: text, thumb } of raw.sparks) {
    const url = toSparkUrl(text)
    if (url) sparks.push({ groupKey: known.has(groupId) ? groupId : firstKey, title, url, src: thumb })
  }
  if (groups.length > LIMITS.groups) throw new LimitError(`The file has ${groups.length} groups, FireDial holds at most ${LIMITS.groups}`)
  if (sparks.length > LIMITS.sparks) throw new LimitError(`The file has ${sparks.length} sparks, FireDial holds at most ${LIMITS.sparks}`)
  if (!sparks.length) throw new Error('The file has no sparks, so nothing was imported')
  return { groups, sparks, prefs: normalizePrefs(raw.prefs), skipped: raw.sparks.length - sparks.length }
}
