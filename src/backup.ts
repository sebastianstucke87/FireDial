// Backup files.

import * as z from 'zod/mini'

import { LabelText, LimitError, LIMITS, listOf, normalizePrefs, plural, Text, toLabelNames, toSparkUrl, View } from './model.ts'
import type { Doc, ThumbId } from './model.ts'
import type { ImportedData, ImportedSpark, ImportedView } from './store.ts'

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

export function importSummary(views: number, sparks: number, skipped: number): string {
  return `Imported ${plural(views, 'view')} with ${plural(sparks, 'spark')}${skipped ? `, skipped ${skipped} (URL empty or too long)` : ''}`
}

// In parts, so the file may get bigger than a single string can. No version number: an import
// reads what a file has (labels, say) and takes defaults for what it hasn't.
export function exportParts(doc: Doc, images: ReadonlyMap<ThumbId, string>): string[] {
  const { format, prefs, views } = { format: 'firedial', prefs: doc.prefs, views: doc.views }
  const sparks = doc.sparks.map((spark, index) => {
    const { thumb, ...fields } = spark
    return `${index ? ',' : ''}${JSON.stringify({ ...fields, thumb: thumb ? (images.get(thumb) ?? '') : '' })}`
  })
  return [`{"format":${JSON.stringify(format)},"prefs":${JSON.stringify(prefs)},"views":${JSON.stringify(views)},"sparks":[`, ...sparks, ']}']
}

const Key = z.catch(z.coerce.number(), Number.NaN)

// Views come as they were saved: order by the sparks' ids in the file. A file without views is
// from a version with groups, which isn't read any more.
const BackupFile = z.object({
  format: z.literal('firedial'),
  views: z.array(z.unknown()),
  sparks: listOf(z.object({ id: Key, title: LabelText, url: Text, thumb: z.catch(z.string(), ''), labels: z.catch(z.array(z.unknown()), []) })),
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
  const sparks: ImportedSpark[] = []
  for (const { id, title, url: text, thumb, labels } of raw.sparks) {
    const url = toSparkUrl(text)
    if (url) sparks.push({ key: id, title, url, src: thumb, labels: toLabelNames(labels) })
  }
  const views: ImportedView[] = []
  for (const item of raw.views) {
    if (typeof item !== 'object' || item === null) continue
    const view = View.safeParse({ ...item, id: 0 })
    if (!view.success) continue
    const { kind, title, sort, rule, order } = view.data
    views.push({ kind, title, sort, rule, order })
  }
  if (views.length > LIMITS.views) throw new LimitError(`The file has ${views.length} views, FireDial holds at most ${LIMITS.views}`)
  if (sparks.length > LIMITS.sparks) throw new LimitError(`The file has ${sparks.length} sparks, FireDial holds at most ${LIMITS.sparks}`)
  if (!sparks.length) throw new Error('The file has no sparks, so nothing was imported')
  return { views, sparks, prefs: normalizePrefs(raw.prefs), skipped: raw.sparks.length - sparks.length }
}
