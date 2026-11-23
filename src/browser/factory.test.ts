import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chromeFor } from './chrome.ts'
import { edge } from './edge.ts'
import { firefox } from './firefox.ts'
import { adapt, browserFor, productOf } from './factory.ts'
import { currentBrowser } from './index.ts'

const api = (base: string, more: Record<string, unknown> = {}): { runtime: { getURL(path: string): string } } & Record<string, unknown> => ({
  runtime: { getURL: (path: string) => `${base}${path}` },
  ...more
})

test('Firefox keeps its browser.*, though it has chrome.* too', () => {
  const firefox = api('moz-extension://uuid/')
  const scope = { browser: firefox, chrome: firefox }
  assert.equal(adapt(scope), false)
  assert.equal(scope.browser, firefox)
})

interface Scope {
  browser?: ReturnType<typeof api> | undefined
  chrome?: ReturnType<typeof api> | undefined
}

test('without either, nothing changes', () => {
  const scope: Scope = {}
  assert.equal(adapt(scope), false)
  assert.equal(scope.browser, undefined)
})

for (const [kind, scopeOf] of [
  ['only chrome.*', (chrome: ReturnType<typeof api>): Scope => ({ chrome })],
  ['browser.* too', (chrome: ReturnType<typeof api>): Scope => ({ browser: chrome, chrome })]
] as const) {
  test(`Chrome with ${kind}: browser.* is chrome.*, with contextMenus as menus`, () => {
    const contextMenus = { name: 'contextMenus' }
    const bookmarks = { name: 'bookmarks' }
    const scope = scopeOf(api('chrome-extension://id/', { contextMenus, bookmarks }))
    assert.equal(adapt(scope), true)
    const adapted = scope.browser
    assert.ok(adapted)
    assert.equal(adapted['menus'], contextMenus)
    assert.equal(adapted['bookmarks'], bookmarks)
    assert.equal(adapted['contextMenus'], contextMenus)
    const other = api('chrome-extension://other/')
    scope.browser = other
    assert.equal(scope.browser, other, 'stays writable')
    const { writable, configurable } = Object.getOwnPropertyDescriptor(scope, 'browser') ?? {}
    assert.deepEqual([writable, configurable], [true, true])
  })
}

test('in Node, which is neither, FireDial counts as in Firefox', () => {
  assert.equal(currentBrowser, firefox)
})

test("the browser is picked by the address of FireDial's pages", () => {
  assert.equal(browserFor({ browser: api('moz-extension://uuid/') }, undefined), firefox)
  const chrome = browserFor({ chrome: api('chrome-extension://id/') }, { brands: [{ brand: 'Google Chrome' }] })
  assert.equal(chrome.product, 'Chrome')
  assert.equal(browserFor({ chrome: api('chrome-extension://id/') }, { brands: [{ brand: 'Microsoft Edge' }, { brand: 'Chromium' }] }), edge)
  const brave = browserFor({ chrome: api('chrome-extension://id/') }, { brands: [{ brand: 'Brave' }] })
  assert.equal(brave.product, 'Brave')
})

test('a browser made from Chromium is known by its brand, without the maker', () => {
  const brands = (...names: string[]): unknown => ({ brands: names.map((brand) => ({ brand })) })
  assert.equal(productOf(brands('Not)A;Brand', 'Chromium', 'Google Chrome')), 'Chrome')
  assert.equal(productOf(brands('Microsoft Edge', 'Chromium', 'Not A(Brand')), 'Edge')
  assert.equal(productOf(brands('Chromium', 'Brave')), 'Brave')
  assert.equal(productOf(brands('Chromium')), 'Chrome')
  assert.equal(productOf(brands('Not_A Brand', 'Opera')), 'Opera')
  assert.equal(productOf(brands('Not=A?Brand', 'Vivaldi')), 'Vivaldi')
  assert.equal(productOf(brands('Google Chrome Beta')), 'Chrome Beta')
  assert.equal(productOf(brands('NotA Brand', 'Not ABrand', 'Chromium')), 'Chrome')
  assert.equal(productOf(brands('GoogleChrome')), 'GoogleChrome')
  assert.equal(productOf(brands('My Google Chrome')), 'My Google Chrome')
  assert.equal(productOf(undefined), 'Chrome')
  assert.equal(productOf({ brands: 'broken' }), 'Chrome')
})

interface Call {
  method: string
  details: unknown
}

function fakeSearch(chrome: boolean): { calls: Call[]; api: Parameters<typeof firefox.searchWeb>[0] } {
  const calls: Call[] = []
  const engines = [{ name: 'Example', isDefault: true }]
  const query = (details: unknown): Promise<void> => {
    calls.push({ method: 'query', details })
    return Promise.resolve()
  }
  const search = (details: unknown): Promise<void> => {
    calls.push({ method: 'search', details })
    return Promise.resolve()
  }
  return { calls, api: chrome ? { query, search } : { get: () => Promise.resolve(engines), query, search } }
}

test('Firefox lists its engines and searches with the one picked', async () => {
  const { calls, api } = fakeSearch(false)
  assert.deepEqual(await firefox.searchEngines(api), [{ name: 'Example', isDefault: true }])
  await firefox.searchWeb(api, 'cats', 'Example')
  await firefox.searchWeb(api, 'dogs', undefined)
  assert.deepEqual(calls, [
    { method: 'search', details: { query: 'cats', engine: 'Example', disposition: 'CURRENT_TAB' } },
    { method: 'search', details: { query: 'dogs', disposition: 'CURRENT_TAB' } }
  ])
})

test('Chrome has no engines to list and searches with its default one', async () => {
  const { calls, api } = fakeSearch(true)
  const chrome = chromeFor('Chrome')
  assert.deepEqual(await chrome.searchEngines(api), [])
  await chrome.searchWeb(api, 'cats', 'Example')
  assert.deepEqual(calls, [{ method: 'query', details: { text: 'cats', disposition: 'CURRENT_TAB' } }])
})
