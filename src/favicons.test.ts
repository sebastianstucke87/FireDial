import assert from 'node:assert/strict'
import { test } from 'node:test'

import { iconUrls, loadIcons, runAdaptive } from './favicons.ts'

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
