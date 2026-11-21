import assert from 'node:assert/strict'
import { test } from 'node:test'

import { iconUrls, loadIcons, pageStart, runAdaptive } from './favicons.ts'

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
    'https://a.example/': '<link rel="apple-touch-icon" href="/missing.png"><link rel="icon" href="/ok.png">',
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
  assert.ok(
    asked.every((url) => /^https:\/\/[abc]\.example\//.test(url)),
    asked.join()
  )
})

test('the limit follows each answer: twice the quickest still counts as steady, slower halves it', async () => {
  const { now, wait } = clock()
  const times = [10, 10, 10, 10, 10, 10, 10, 10, 20, 10, 10, 10, 10, 10, 10, 10, 10, 10, 21, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]
  const seen: string[] = []
  await runAdaptive(
    times.map((_, index) => index),
    async (index) => {
      await wait(times[index] ?? 0)
      return true
    },
    {
      now,
      onDone: (done, pool) => {
        seen.push(`${done}:${pool.limit}`)
      }
    }
  )
  assert.equal(
    seen.join(' '),
    '1:8 2:8 3:8 4:8 5:8 6:8 7:8 8:10 9:10 10:10 11:10 12:10 13:10 14:10 15:10 16:10 17:10 18:12 19:12 20:12 21:12 22:12 23:12 24:12 25:12 26:12 27:12 28:12 29:12 30:6'
  )
})

test('work that throws counts as failed', async () => {
  const limits: number[] = []
  await runAdaptive([1, 2], () => Promise.reject(new Error('no')), {
    onDone: (_, pool) => {
      limits.push(pool.limit)
    }
  })
  assert.deepEqual(limits, [4, 2])
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
  const limits: number[] = []
  const fetcher: typeof fetch = (_, init) => {
    if (init) inits.push(init)
    return Promise.resolve(new Response('<link rel="icon" href="/x.png">', { status: 404 }))
  }
  const icons = await loadIcons(['https://a.example', 'https://b.example'], () => Promise.resolve('data:image/png,x'), {
    fetcher,
    onDone: (_, pool) => {
      limits.push(pool.limit)
    }
  })
  assert.equal(icons.size, 0, 'a 404 page names no icons, a 404 icon is none')
  assert.deepEqual(limits, [4, 2])
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
