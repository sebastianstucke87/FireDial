// Icons for sparks without a picture, from each site itself: its home page names the icons, and
// its web app manifest more, the biggest one wins, /favicon.ico when it names none. No other
// service hears of the sites.
//
// Many sites at once, as many as keep answering fast: a few to begin with, more while the typical
// time stays steady, half as many as soon as it climbs. Typical is the middle of the last few
// answers, a failure counting as the slowest: one slow or dead site among them changes nothing,
// as sites differ anyway; most of them slowing down or failing does.

import * as z from 'zod/mini'

const FETCH_TIMEOUT = 6000 // ms, for a page or an icon
const START = 8
const MOST = 20
const FEWEST = 2
const STEP = 2
const SLOWER = 2 // times the steady time that count as climbing
const WINDOW = 8 // the last answers whose middle time is the typical one
const PAGE_MAX = 1024 ** 2 // bytes of a home page read for its icons, which its head names
const MANIFEST_MAX = 256 * 1024 // bytes of a web app manifest read
const TOUCH = 2000 // rank of the icons made for home screens (apple-touch-icon, manifest): big and filled

export interface IconLink {
  url: string
  rank: number
}

const attribute = (tag: string, name: string): string | null => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null
}

// The largest size named, any being the largest of all.
function sizeOf(sizes: string | null): number {
  if (!sizes) return 0
  if (/\bany\b/i.test(sizes)) return 1000
  return Math.max(0, ...[...sizes.matchAll(/(\d+)x\d+/gi)].map((match) => Number(match[1])))
}

// The base a page's addresses are relative to.
function baseOf(html: string, pageUrl: string): string {
  const base = attribute(/<base\b[^>]*>/i.exec(html)?.[0] ?? '', 'href')
  try {
    return new URL(base ?? '', pageUrl).href
  } catch {
    return pageUrl // a broken <base>: the page's own address
  }
}

// The web app manifest a page names, if any.
export function manifestUrl(html: string, pageUrl: string): string | null {
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/)
    const href = attribute(tag, 'href')
    if (!rel.includes('manifest') || !href) continue
    try {
      const url = new URL(href, baseOf(html, pageUrl))
      return /^https?:$/.test(url.protocol) ? url.href : null
    } catch {
      return null
    }
  }
  return null
}

const Manifest = z.object({ icons: z.array(z.unknown()) })
const ManifestIcon = z.object({ src: z.string(), sizes: z.optional(z.string()), purpose: z.optional(z.string()) })

// The icons a web app manifest names, ranked as a page's. Maskable ones have room around the
// picture for a home screen's own shape: after the others.
export function manifestIcons(text: string, url: string): IconLink[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const icons = Manifest.safeParse(data).data?.icons ?? []
  const links: IconLink[] = []
  for (const icon of icons) {
    const { src, sizes, purpose } = ManifestIcon.safeParse(icon).data ?? {}
    if (!src) continue
    try {
      const maskableOnly = !!purpose && !/\bany\b/i.test(purpose) && /\bmaskable\b/i.test(purpose)
      links.push({ url: new URL(src, url).href, rank: (maskableOnly ? TOUCH / 2 : TOUCH) + sizeOf(sizes ?? null) })
    } catch {
      // the next one
    }
  }
  return links
}

// The icons a page names, and its manifest's (more), best first, and /favicon.ico last.
export function iconUrls(html: string, pageUrl: string, more: readonly IconLink[] = []): string[] {
  const links: IconLink[] = [...more]
  const baseUrl = baseOf(html, pageUrl)
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/)
    const href = attribute(tag, 'href')
    if (!href) continue
    let url: string
    try {
      url = new URL(href, baseUrl).href
    } catch {
      continue
    }
    if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) links.push({ url, rank: TOUCH + sizeOf(attribute(tag, 'sizes')) })
    else if (rel.includes('icon')) links.push({ url, rank: sizeOf(attribute(tag, 'sizes')) || 16 })
  }
  const ordered = links.sort((a, b) => b.rank - a.rank).map((link) => link.url)
  return [...new Set([...ordered, new URL('/favicon.ico', pageUrl).href])]
}

export interface Pool {
  readonly limit: number
}

// Runs work on every item, at most limit at a time, the limit following how it goes.
export async function runAdaptive<Item>(
  items: readonly Item[],
  work: (item: Item) => Promise<boolean>, // false: it failed
  options: { now?: () => number; signal?: AbortSignal; onDone?: (done: number, pool: Pool, ok: boolean) => void } = {}
): Promise<void> {
  const now = options.now ?? (() => performance.now())
  const pool = { limit: START }
  let next = 0
  let running = 0
  let done = 0
  let steady = Infinity // the quickest typical time so far
  let recent: number[] = []
  let sinceChange = 0

  const settle = (time: number, ok: boolean): void => {
    recent = [...recent, ok ? time : Infinity].slice(-WINDOW)
    const sorted = recent.toSorted((a, b) => a - b)
    const typical = sorted[Math.floor((sorted.length - 1) / 2)] ?? time
    if (recent.length === WINDOW) steady = Math.min(steady, typical)
    if (recent.length === WINDOW && (typical === Infinity || typical > steady * SLOWER)) {
      pool.limit = Math.max(FEWEST, Math.floor(pool.limit / 2))
      recent = [] // judged anew on the answers from now on
      sinceChange = 0
    } else if (ok && ++sinceChange >= pool.limit) {
      pool.limit = Math.min(MOST, pool.limit + STEP)
      sinceChange = 0
    }
  }

  await new Promise<void>((resolve) => {
    const fill = (): void => {
      if (!running && (next >= items.length || options.signal?.aborted)) {
        resolve()
        return
      }
      while (running < pool.limit && next < items.length && !options.signal?.aborted) {
        const item = items[next]
        next += 1
        if (item === undefined) continue
        running += 1
        const start = now()
        void work(item)
          .catch(() => false)
          .then((ok) => {
            running -= 1
            done += 1
            settle(Math.max(1, now() - start), ok)
            options.onDone?.(done, pool, ok)
            fill()
          })
      }
    }
    fill()
  })
}

// The start of a page's text, up to max bytes: the rest isn't loaded.
export async function pageStart(response: Response, max: number = PAGE_MAX): Promise<string> {
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for (let part = await reader?.read(); part && !part.done; part = await reader?.read()) {
    text += decoder.decode(part.value.subarray(0, max - size), { stream: true })
    size += part.value.byteLength
    if (size >= max) {
      await reader?.cancel().catch(() => undefined)
      break
    }
  }
  return text + decoder.decode()
}

// fetch with a time limit, which an abort of the whole run also ends.
async function fetchWithin(url: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Response> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT)
  return fetcher(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, credentials: 'omit', redirect: 'follow' })
}

// The icon of each site, by origin. toImage turns an answer into what's kept (a data URL), or
// null when it's no usable image. Sites without one are missing from the result; onIcon hears of
// each one found at once.
export async function loadIcons(
  origins: readonly string[],
  toImage: (response: Response) => Promise<string | null>,
  options: {
    fetcher?: typeof fetch
    signal?: AbortSignal
    now?: () => number
    onDone?: (done: number, pool: Pool, ok: boolean) => void
    onIcon?: (origin: string, src: string) => void
  } = {}
): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const fetcher = options.fetcher ?? fetch
  await runAdaptive(
    origins,
    async (origin) => {
      const page = `${origin}/`
      let html = ''
      try {
        const response = await fetchWithin(page, options.signal, fetcher)
        if (response.ok) html = await pageStart(response)
      } catch {
        // no page: /favicon.ico may still be there
      }
      let more: IconLink[] = []
      const manifest = manifestUrl(html, page)
      if (manifest) {
        try {
          const response = await fetchWithin(manifest, options.signal, fetcher)
          if (response.ok) more = manifestIcons(await pageStart(response, MANIFEST_MAX), response.url || manifest)
        } catch {
          // the page's own icons
        }
      }
      for (const url of iconUrls(html, page, more)) {
        try {
          const response = await fetchWithin(url, options.signal, fetcher)
          const image = response.ok ? await toImage(response) : null
          if (image) {
            found.set(origin, image)
            options.onIcon?.(origin, image)
            return true
          }
        } catch {
          // the next one
        }
      }
      return html !== ''
    },
    options
  )
  return found
}
