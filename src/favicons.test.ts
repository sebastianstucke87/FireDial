import assert from 'node:assert/strict'
import { test } from 'node:test'

import { iconUrls, loadIcons, manifestIcons, manifestUrl, pageStart, runAdaptive } from './favicons.ts'

test('the biggest icon a page names comes first, /favicon.ico last', () => {
  const html = `<head>
    <link rel="icon" href="/small.png" sizes="16x16">
    <link rel="shortcut icon" href="favicon-32.png" sizes="32x32">
    <LINK REL='apple-touch-icon' HREF='/touch.png'>
    <link href="https://cdn.example/big.png" rel="icon" sizes="192x192 96x96">
    <link rel="mask-icon" href="/mask.svg">
    <link rel="stylesheet" href="/style.css">
  </head>`
  assert.deepEqual(iconUrls(html, 'https://a.example/'), [
    'https://a.example/touch.png',
    'https://cdn.example/big.png',
    'https://a.example/favicon-32.png',
    'https://a.example/small.png',
    'https://a.example/favicon.ico'
  ])
})

test('a page without icons, or broken ones, still has /favicon.ico', () => {
  assert.deepEqual(iconUrls('', 'https://a.example/'), ['https://a.example/favicon.ico'])
  assert.deepEqual(iconUrls('<link rel="icon"><link rel="icon" href="http://[bad">', 'https://a.example/x/'), ['https://a.example/favicon.ico'])
  assert.deepEqual(iconUrls('<link rel="icon" href="/favicon.ico">', 'https://a.example/'), ['https://a.example/favicon.ico'], 'once')
})

test('relative icons follow <base>, any size counts as the biggest', () => {
  const html = '<base href="https://static.example/assets/"><link rel="icon" href="i.png" sizes="any"><link rel="icon" href="j.png" sizes="512x512">'
  assert.deepEqual(iconUrls(html, 'https://a.example/'), [
    'https://static.example/assets/i.png',
    'https://static.example/assets/j.png',
    'https://a.example/favicon.ico'
  ])
})

test('a web app manifest adds its icons, the biggest first, maskable ones after the others', () => {
  const html =
    '<base href="https://a.example/app/"><link rel="manifest" href="site.webmanifest"><link rel="apple-touch-icon" href="/touch.png" sizes="180x180">'
  const url: string | null = manifestUrl(html, 'https://a.example/')
  assert.equal(url, 'https://a.example/app/site.webmanifest')
  const manifest = JSON.stringify({
    icons: [
      { src: 'i/192.png', sizes: '192x192' },
      { src: 'i/512.png', sizes: '512x512', purpose: 'any maskable' },
      { src: 'i/mask.png', sizes: '1024x1024', purpose: 'maskable' },
      { sizes: '64x64' },
      'broken'
    ]
  })
  assert.deepEqual(iconUrls(html, 'https://a.example/', manifestIcons(manifest, 'https://a.example/app/site.webmanifest')), [
    'https://a.example/app/i/512.png',
    'https://a.example/app/i/192.png',
    'https://a.example/touch.png',
    'https://a.example/app/i/mask.png',
    'https://a.example/favicon.ico'
  ])
})

test('a missing, broken or odd manifest adds nothing', () => {
  assert.equal(manifestUrl('<link rel="icon" href="/i.png">', 'https://a.example/'), null)
  assert.equal(manifestUrl('<link rel="manifest" href="javascript:alert(1)">', 'https://a.example/'), null)
  assert.deepEqual(manifestIcons('not json', 'https://a.example/m.json'), [])
  assert.deepEqual(manifestIcons('{"icons": "none"}', 'https://a.example/m.json'), [])
  assert.deepEqual(manifestIcons('null', 'https://a.example/m.json'), [])
})

// A clock that jumps from one finished wait to the next, as a real one would get there.
function clock(): { now: () => number; wait: (ms: number) => Promise<void> } {
  let time = 0
  const pending: { at: number; resolve: () => void }[] = []
  let ticking = false
  const tick = (): void => {
    ticking = false
    pending.sort((a, b) => a.at - b.at)
    const first = pending.shift()
    if (!first) return
    time = first.at
    first.resolve()
    schedule()
  }
  const schedule = (): void => {
    if (ticking || !pending.length) return
    ticking = true
    setImmediate(tick)
  }
  return {
    now: () => time,
    wait: (ms) =>
      new Promise((resolve) => {
        pending.push({ at: time + ms, resolve })
        schedule()
      })
  }
}

test('steady work goes up to 20 at once, never more than the limit at the time', async () => {
  const { now, wait } = clock()
  let running = 0
  let most = 0
  const limits: number[] = []
  await runAdaptive(
    Array.from({ length: 300 }, (_, index) => index),
    async () => {
      running += 1
      most = Math.max(most, running)
      await wait(10)
      running -= 1
      return true
    },
    {
      now,
      onDone: (_, pool) => {
        limits.push(pool.limit)
      }
    }
  )
  assert.equal(limits.length, 300)
  assert.equal(limits[0], 8)
  assert.equal(Math.max(...limits), 20)
  assert.equal(limits.at(-1), 20)
  assert.ok(most <= 20, String(most))
})

test('failures and slow answers halve the limit, down to 2', async () => {
  const { now, wait } = clock()
  const limits: number[] = []
  await runAdaptive(
    Array.from({ length: 40 }, (_, index) => index),
    async (index) => {
      await wait(index < 10 ? 10 : 100)
      return index % 2 === 0
    },
    {
      now,
      onDone: (_, pool) => {
        limits.push(pool.limit)
      }
    }
  )
  assert.ok(limits.includes(4), limits.join())
  assert.equal(Math.min(...limits), 2)
})

test('an abort starts nothing new, and all items run without one', async () => {
  const controller = new AbortController()
  let started = 0
  await runAdaptive(
    Array.from({ length: 50 }, (_, index) => index),
    async () => {
      started += 1
      if (started === 3) controller.abort()
      await Promise.resolve()
      return true
    },
    { signal: controller.signal }
  )
  assert.ok(started <= 8, String(started))
  let all = 0
  await runAdaptive([1, 2, 3], async () => {
    all += 1
    return Promise.resolve(true)
  })
  assert.equal(all, 3)
  await runAdaptive([], () => Promise.resolve(true))
})

test('each site gets the first icon that loads, from the site itself only', async () => {
  const asked: string[] = []
  const pages: Record<string, string> = {
    'https://a.example/': '<link rel="apple-touch-icon" href="/missing.png"><link rel="icon" href="/ok.png"><link rel="manifest" href="/m.json">',
    'https://a.example/m.json': '{"icons": [{"src": "/big.png", "sizes": "512x512"}]}',
    'https://b.example/': ''
  }
  const fetcher: typeof fetch = (input) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    asked.push(url)
    if (url in pages) return Promise.resolve(new Response(pages[url], { status: 200 }))
    if (url.endsWith('/ok.png') || url === 'https://b.example/favicon.ico')
      return Promise.resolve(new Response('img', { status: 200, headers: { 'content-type': 'image/png' } }))
    if (url.startsWith('https://c.example')) return Promise.reject(new TypeError('offline'))
    return Promise.resolve(new Response('', { status: 404 }))
  }
  const icons = await loadIcons(
    ['https://a.example', 'https://b.example', 'https://c.example'],
    async (response) => `data:${response.headers.get('content-type') ?? ''},${await response.text()}`,
    { fetcher }
  )
  assert.deepEqual(
    [...icons].sort(([a], [b]) => a.localeCompare(b)),
    [
      ['https://a.example', 'data:image/png,img'],
      ['https://b.example', 'data:image/png,img']
    ]
  )
  assert.ok(asked.indexOf('https://a.example/big.png') < asked.indexOf('https://a.example/ok.png'), 'the big icon of the manifest is tried first')
  assert.ok(
    asked.every((url) => /^https:\/\/[abc]\.example\//.test(url)),
    asked.join()
  )
})

test('one slow answer among quick ones changes nothing; the typical time climbing halves the limit', async () => {
  const { now, wait } = clock()
  const times = [...Array<number>(8).fill(10), 1000, ...Array<number>(11).fill(10), ...Array<number>(12).fill(30)]
  const seen: number[] = []
  await runAdaptive(
    times.map((_, index) => index),
    async (index) => {
      await wait(times[index] ?? 0)
      return true
    },
    {
      now,
      onDone: (_, pool) => {
        seen.push(pool.limit)
      }
    }
  )
  const drop = seen.findIndex((limit, index) => index > 0 && limit < (seen[index - 1] ?? 0))
  assert.ok(drop >= 20, `no halving for the one slow answer: ${seen.join()}`)
  assert.ok(Math.min(...seen.slice(20)) < Math.max(...seen.slice(0, 20)), `halved once most answers are slower: ${seen.join()}`)
})

test('work that throws counts as failed: most of the last answers failing halves the limit', async () => {
  const limits: number[] = []
  await runAdaptive(
    Array.from({ length: 16 }, (_, index) => index),
    () => Promise.reject(new Error('no')),
    {
      onDone: (_, pool) => {
        limits.push(pool.limit)
      }
    }
  )
  assert.deepEqual(limits, [...Array<number>(7).fill(8), 4, ...Array<number>(7).fill(4), 2])
})

test('missing items are skipped', async () => {
  const worked: unknown[] = []
  await runAdaptive([1, undefined, 2], (item) => {
    worked.push(item)
    return Promise.resolve(true)
  })
  assert.deepEqual(worked, [1, 2])
})

test('touch icons rank by size above all others, precomposed ones too', () => {
  const html = `<link rel="icon" href="/any.svg" sizes="any">
    <link rel="apple-touch-icon" href="/t120.png" sizes="120x120">
    <link rel="apple-touch-icon-precomposed" href="/t180.png" sizes="180x180">`
  assert.deepEqual(iconUrls(html, 'https://a.example/'), [
    'https://a.example/t180.png',
    'https://a.example/t120.png',
    'https://a.example/any.svg',
    'https://a.example/favicon.ico'
  ])
})

test('without <base>, relative icons follow the page address', () => {
  assert.deepEqual(iconUrls('<link rel="icon" href="i.png">', 'https://a.example/x/y'), ['https://a.example/x/i.png', 'https://a.example/favicon.ico'])
})

test('a page is read only up to the limit', async () => {
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1
      controller.enqueue(new TextEncoder().encode('abcd'))
    }
  })
  assert.equal(await pageStart(new Response(body), 6), 'abcdab')
  assert.ok(pulled <= 3, String(pulled))
  assert.equal(await pageStart(new Response('héllo')), 'héllo')
  assert.equal(await pageStart(new Response(null)), '')
})

test('sites are asked without cookies, and a site without page or icon counts as failed', async () => {
  const inits: RequestInit[] = []
  const oks: boolean[] = []
  const fetcher: typeof fetch = (_, init) => {
    if (init) inits.push(init)
    return Promise.resolve(new Response('<link rel="icon" href="/x.png">', { status: 404 }))
  }
  const icons = await loadIcons(['https://a.example', 'https://b.example'], () => Promise.resolve('data:image/png,x'), {
    fetcher,
    onDone: (_, __, ok) => {
      oks.push(ok)
    }
  })
  assert.equal(icons.size, 0, 'a 404 page names no icons, a 404 icon is none')
  assert.deepEqual(oks, [false, false])
  assert.equal(inits.length, 4, 'each site: its page, then only /favicon.ico')
  for (const init of inits) {
    assert.equal(init.credentials, 'omit')
    assert.equal(init.redirect, 'follow')
    assert.ok(init.signal instanceof AbortSignal)
  }
})

test('a site whose page loads counts as working even without an icon, one with an icon too', async () => {
  const limits: number[] = []
  const fetcher: typeof fetch = (input) =>
    Promise.resolve((typeof input === 'string' ? input : '').endsWith('/') ? new Response('<p>', { status: 200 }) : new Response('', { status: 404 }))
  await loadIcons(['https://a.example'], () => Promise.resolve(null), {
    fetcher,
    onDone: (_, pool) => {
      limits.push(pool.limit)
    }
  })
  assert.deepEqual(limits, [8])
  const found = await loadIcons(['https://b.example'], () => Promise.resolve('data:image/png,x'), {
    fetcher: () => Promise.resolve(new Response('', { status: 200 })),
    onDone: (_, pool) => {
      limits.push(pool.limit)
    }
  })
  assert.equal(found.get('https://b.example'), 'data:image/png,x')
  assert.deepEqual(limits, [8, 8])
})

test('a character split over two parts of a page stays whole', async () => {
  const bytes = new TextEncoder().encode('é')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 1))
      controller.enqueue(bytes.subarray(1))
      controller.close()
    }
  })
  assert.equal(await pageStart(new Response(body)), 'é')
})

test('an icon that is only a query belongs to the page itself', () => {
  assert.deepEqual(iconUrls('<link rel="icon" href="?v=2">', 'https://a.example/x/y'), ['https://a.example/x/y?v=2', 'https://a.example/favicon.ico'])
})
