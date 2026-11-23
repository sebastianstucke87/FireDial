import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ICON_RETRY, iconKey, iconWidth, isSmallIcon, originOfKey, SiteIcons } from './icons.ts'
import type { KeyValue } from './store.ts'

function memory(): KeyValue & { data: Map<string, unknown>; reads: number } {
  const data = new Map<string, unknown>()
  const kv = {
    data,
    reads: 0,
    get(keys: string | string[]) {
      kv.reads += 1
      const list = [keys].flat()
      return Promise.resolve(Object.fromEntries(list.filter((key) => data.has(key)).map((key) => [key, structuredClone(data.get(key))])))
    },
    set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value))
      return Promise.resolve()
    },
    remove() {
      return Promise.resolve()
    },
    onChanged() {}
  }
  return kv
}

const ICON = 'data:image/png;base64,AAAA'

test('an icon is kept per site, for this browser and the next tab', async () => {
  const kv = memory()
  let now = 1000
  const icons = new SiteIcons(kv, () => now)
  await icons.load(['https://a.example', 'https://b.example'])
  assert.deepEqual(icons.due(['https://a.example', 'https://b.example']), ['https://a.example', 'https://b.example'])
  await icons.save(['https://a.example', 'https://b.example'], new Map([['https://a.example', ICON]]))
  assert.equal(icons.get('https://a.example'), ICON)
  assert.equal(icons.get('https://b.example'), '')
  assert.deepEqual(kv.data.get(iconKey('https://b.example')), { src: '', at: 1000 })
  const next = new SiteIcons(kv, () => now)
  await next.load(['https://a.example', 'https://b.example'])
  assert.equal(next.get('https://a.example'), ICON)
  assert.deepEqual(next.due(['https://a.example', 'https://b.example']), [], 'none found just now: not asked again yet')
  now += ICON_RETRY
  assert.deepEqual(next.due(['https://a.example', 'https://b.example']), ['https://b.example'], 'a week later it is')
})

test('sites read once are not read again until another tab changes them', async () => {
  const kv = memory()
  const icons = new SiteIcons(kv)
  await icons.load(['https://a.example'])
  await icons.save(['https://a.example'], new Map([['https://a.example', ICON]]))
  const reads = kv.reads
  await icons.load(['https://a.example'])
  await icons.save([], new Map())
  assert.equal(kv.reads, reads)
  icons.forget(['https://a.example'])
  assert.equal(icons.get('https://a.example'), '')
  await icons.load(['https://a.example'])
  assert.equal(icons.get('https://a.example'), ICON)
})

test('only images count as icons, stored or found', async () => {
  const kv = memory()
  kv.data.set(iconKey('https://a.example'), { src: 'javascript:alert(1)', at: 1 })
  kv.data.set(iconKey('https://b.example'), 'broken')
  const icons = new SiteIcons(kv)
  await icons.load(['https://a.example', 'https://b.example'])
  assert.equal(icons.get('https://a.example'), '')
  assert.deepEqual(icons.due(['https://b.example']), ['https://b.example'])
  await icons.save(['https://c.example'], new Map([['https://c.example', 'https://c.example/i.png']]))
  assert.equal(icons.get('https://c.example'), '')
})

test('icon keys name their site', () => {
  assert.equal(originOfKey(iconKey('https://a.example')), 'https://a.example')
  assert.equal(originOfKey('thumb:1'), null)
})

// A PNG's header, as wide as asked: enough for iconWidth.
const png = (width: number): string => {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(bytes)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(width, 20)
  return `data:image/png;base64,${bytes.toString('base64')}`
}

test('a PNG icon tells its width; small ones are worth a bigger one', () => {
  assert.equal(iconWidth(png(32)), 32)
  assert.equal(iconWidth(png(300)), 300)
  assert.equal(iconWidth(ICON), null, 'too short for a header')
  assert.equal(iconWidth('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='), null)
  assert.equal(isSmallIcon(png(64)), true)
  assert.equal(isSmallIcon(png(96)), false)
  assert.equal(isSmallIcon('data:image/svg+xml,<svg/>'), false, 'any size')
})

test('a small icon is looked for at its site once; nothing bigger found keeps it', async () => {
  const kv = memory()
  const icons = new SiteIcons(kv)
  const small = png(32)
  await icons.load(['https://a.example', 'https://b.example'])
  await icons.save(
    ['https://a.example', 'https://b.example'],
    new Map([
      ['https://a.example', small],
      ['https://b.example', png(96)]
    ])
  )
  assert.deepEqual(icons.upgradable(['https://a.example', 'https://b.example', 'https://c.example']), ['https://a.example'])
  await icons.save(['https://a.example'], new Map(), new Set(['https://a.example']))
  assert.equal(icons.get('https://a.example'), small)
  assert.deepEqual(icons.upgradable(['https://a.example']), [], 'asked once')
  await icons.save(['https://a.example'], new Map([['https://a.example', small]]))
  const next = new SiteIcons(kv)
  await next.load(['https://a.example'])
  assert.deepEqual(next.upgradable(['https://a.example']), [], 'still asked, in the next tab too')
})
