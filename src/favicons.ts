// Icons for sparks without a picture, from each site itself: its home page names the icons, the
// biggest one wins, /favicon.ico when it names none. No other service hears of the sites.
//
// Many sites at once, as many as keep answering fast: a few to begin with, more while the times
// stay steady, half as many as soon as they climb or fail.

const FETCH_TIMEOUT = 6000 // ms, for a page or an icon
const START = 8
const MOST = 20
const FEWEST = 2
const STEP = 2
const SLOWER = 2 // times the steady time that count as climbing

interface IconLink {
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

// The icons a page names, best first, and /favicon.ico last.
export function iconUrls(html: string, pageUrl: string): string[] {
  const links: IconLink[] = []
  const base = attribute(/<base\b[^>]*>/i.exec(html)?.[0] ?? '', 'href')
  let baseUrl = pageUrl
  try {
    baseUrl = new URL(base ?? '', pageUrl).href
  } catch {
    // a broken <base>: the page's own address
  }
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
    if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) links.push({ url, rank: 2000 + sizeOf(attribute(tag, 'sizes')) })
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
  options: { now?: () => number; signal?: AbortSignal; onDone?: (done: number, pool: Pool) => void } = {}
): Promise<void> {
  const now = options.now ?? (() => performance.now())
  const pool = { limit: START }
  let next = 0
  let running = 0
  let done = 0
  let steady = Infinity // the quickest time seen so far
  let sinceChange = 0

  const settle = (time: number, ok: boolean): void => {
    steady = Math.min(steady, time)
    if (!ok || time > steady * SLOWER) {
      pool.limit = Math.max(FEWEST, Math.floor(pool.limit / 2))
      sinceChange = 0
    } else if (++sinceChange >= pool.limit) {
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
            options.onDone?.(done, pool)
            fill()
          })
      }
    }
    fill()
  })
}

// fetch with a time limit, which an abort of the whole run also ends.
async function fetchWithin(url: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Response> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT)
  return fetcher(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, credentials: 'omit', redirect: 'follow' })
}

// The icon of each site, by origin. toImage turns an answer into what's kept (a data URL), or
// null when it's no usable image. Sites without one are missing from the result.
export async function loadIcons(
  origins: readonly string[],
  toImage: (response: Response) => Promise<string | null>,
  options: { fetcher?: typeof fetch; signal?: AbortSignal; now?: () => number; onDone?: (done: number, pool: Pool) => void } = {}
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
        if (response.ok) html = await response.text()
      } catch {
        // no page: /favicon.ico may still be there
      }
      for (const url of iconUrls(html, page)) {
        try {
          const response = await fetchWithin(url, options.signal, fetcher)
          const image = response.ok ? await toImage(response) : null
          if (image) {
            found.set(origin, image)
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
