// Site icons, for sparks without a preview: one per site, kept in this browser only. A preview is a
// picture of the page and syncs; an icon comes from the browser or the site, in each browser anew.

import * as z from 'zod/mini'

import { isStoredImage } from './images.ts'
import type { KeyValue } from './store.ts'

export const ICON_RETRY = 7 * 24 * 60 * 60 * 1000 // ms before a site found without an icon is asked again
const PREFIX = 'icon:'

const Entry = z.object({ src: z.string(), at: z.number() })
type Entry = z.infer<typeof Entry>

export const iconKey = (origin: string): string => `${PREFIX}${origin}`
export const originOfKey = (key: string): string | null => (key.startsWith(PREFIX) ? key.slice(PREFIX.length) : null)

export class SiteIcons {
  private readonly kv: KeyValue
  private readonly now: () => number
  private readonly known = new Map<string, Entry>()

  constructor(kv: KeyValue, now: () => number = Date.now) {
    this.kv = kv
    this.now = now
  }

  // The icon of a site read before; '' for none.
  get(origin: string): string {
    return this.known.get(origin)?.src ?? ''
  }

  // Reads the sites not read yet.
  async load(origins: readonly string[]): Promise<void> {
    const missing = origins.filter((origin) => !this.known.has(origin))
    if (!missing.length) return
    const data = await this.kv.get(missing.map(iconKey))
    for (const origin of missing) {
      const entry = Entry.safeParse(data[iconKey(origin)])
      if (entry.success) this.known.set(origin, { src: isStoredImage(entry.data.src) ? entry.data.src : '', at: entry.data.at })
    }
  }

  // The sites to look for: never looked for, or found without an icon a while ago.
  due(origins: readonly string[]): string[] {
    return origins.filter((origin) => {
      const entry = this.known.get(origin)
      return !entry || (!entry.src && this.now() - entry.at >= ICON_RETRY)
    })
  }

  // What a look for these sites found: an icon, or none for now.
  async save(looked: readonly string[], found: ReadonlyMap<string, string>): Promise<void> {
    if (!looked.length) return
    const items: Record<string, Entry> = {}
    for (const origin of looked) {
      const src = found.get(origin) ?? ''
      const entry = { src: isStoredImage(src) ? src : '', at: this.now() }
      this.known.set(origin, entry)
      items[iconKey(origin)] = entry
    }
    await this.kv.set(items)
  }

  // Another tab saved these: read again when next asked.
  forget(origins: Iterable<string>): void {
    for (const origin of origins) this.known.delete(origin)
  }
}
