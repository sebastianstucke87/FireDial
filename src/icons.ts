// Site icons, for sparks without a preview: one per site. They go into backups and sync like
// previews, so a new browser has them at once; one without an icon looks for it itself.

import * as z from 'zod/mini'

import { isStoredImage } from './images.ts'
import type { KeyValue } from './store.ts'

export const ICON_RETRY = 7 * 24 * 60 * 60 * 1000 // ms before a site found without an icon is asked again
const PREFIX = 'icon:'
const ICON_MAX = 64 * 1024 // characters of an icon's data URL at most: icons are small

// An icon fit to keep: an image, and a small one.
const isIcon = (src: unknown): src is string => typeof src === 'string' && src.length <= ICON_MAX && isStoredImage(src)

// The site of a web address: its origin, for http and https only.
export function originOf(url: string): string | null {
  try {
    const { origin, protocol } = new URL(url)
    return /^https?:$/.test(protocol) ? origin : null
  } catch {
    return null
  }
}

export const sitesOf = (urls: Iterable<string>): Set<string> => new Set([...urls].map(originOf).filter((origin) => origin !== null))

// Icons as a backup or Drive has them, { origin: data URL }: only the sites asked for, only icons.
export function iconsFrom(data: unknown, sites: ReadonlySet<string>): Map<string, string> {
  const icons = new Map<string, string>()
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return icons
  for (const [origin, src] of Object.entries(data)) if (sites.has(origin) && isIcon(src)) icons.set(origin, src)
  return icons
}

// The icons kept here for these sites.
export async function readIcons(kv: KeyValue, sites: Iterable<string>): Promise<Map<string, string>> {
  const keys = [...sites].map(iconKey)
  const data = keys.length ? await kv.get(keys) : {}
  const icons = new Map<string, string>()
  for (const key of keys) {
    const entry = Entry.safeParse(data[key])
    const origin = originOfKey(key)
    if (origin && entry.success && isIcon(entry.data.src)) icons.set(origin, entry.data.src)
  }
  return icons
}

// Icons from a backup or Drive, for the sites without one here; an icon here stays.
export async function addIcons(kv: KeyValue, icons: ReadonlyMap<string, string>, now: number = Date.now()): Promise<void> {
  const have = await readIcons(kv, icons.keys())
  const items: Record<string, Entry> = {}
  for (const [origin, src] of icons) if (!have.has(origin) && isIcon(src)) items[iconKey(origin)] = { src, at: now }
  if (Object.keys(items).length) await kv.set(items)
}

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
