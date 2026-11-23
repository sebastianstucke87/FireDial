import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chromeFor } from './chrome.ts'
import { edge } from './edge.ts'
import { firefox, SYNC_DATA } from './firefox.ts'
import { ALL_SITES } from './shared.ts'

// The browser.* calls the strategies make, with what they answer.
const calls: [string, ...unknown[]][] = []
let granted = true
let favicon: Response | Error = new Response(new Blob(['icon'], { type: 'image/png' }))

const fake = {
  runtime: { getURL: (path: string) => `chrome-extension://id${path}` },
  windows: { WINDOW_ID_CURRENT: -2 },
  tabs: {
    TAB_ID_NONE: -1,
    captureTab: (...args: unknown[]) => (calls.push(['captureTab', ...args]), Promise.resolve('data:image/jpeg;base64,AA==')),
    captureVisibleTab: (...args: unknown[]) => (calls.push(['captureVisibleTab', ...args]), Promise.resolve('data:image/jpeg;base64,AA==')),
    update: (...args: unknown[]) => (calls.push(['update', ...args]), Promise.resolve({}))
  },
  permissions: {
    request: (...args: unknown[]) => (calls.push(['request', ...args]), Promise.resolve(granted)),
    remove: (...args: unknown[]) => (calls.push(['remove', ...args]), Promise.resolve(true))
  }
}
Object.assign(globalThis, { browser: fake })
Object.assign(globalThis, {
  fetch: (input: string) => {
    calls.push(['fetch', input])
    return favicon instanceof Error ? Promise.reject(favicon) : Promise.resolve(favicon.clone())
  }
})

const chrome = chromeFor('Chrome')
const tab = { id: 5, windowId: 3 }

function take(): [string, ...unknown[]][] {
  return calls.splice(0)
}

test('Firefox captures the tab itself, in the background, and stays where it is', async () => {
  assert.equal(firefox.previewInFront, false)
  await firefox.capture(tab)
  let shown = false
  await firefox.noteOnPage(() => {
    shown = true
    return Promise.resolve()
  })
  await firefox.backTo({ id: 1, windowId: undefined })
  assert.equal(shown, false)
  assert.deepEqual(take(), [['captureTab', 5, { format: 'jpeg', quality: 85 }]])
})

test('Chrome captures the tab in front, notes it there, and goes back to FireDial', async () => {
  assert.equal(chrome.previewInFront, true)
  await chrome.capture(tab)
  await chrome.capture({ id: 5, windowId: undefined })
  let shown = false
  await chrome.noteOnPage(() => {
    shown = true
    return Promise.resolve()
  })
  await chrome.backTo({ id: 1, windowId: undefined })
  await chrome.backTo(undefined)
  assert.equal(shown, true)
  assert.deepEqual(take(), [
    ['captureVisibleTab', 3, { format: 'jpeg', quality: 85 }],
    ['captureVisibleTab', -2, { format: 'jpeg', quality: 85 }],
    ['update', 1, { active: true }]
  ])
})

test("Firefox keeps no icons to ask for; Chrome gives its copy, or '' without one", async () => {
  assert.equal(firefox.keepsIcons, false)
  assert.equal(await firefox.iconOf('https://a.example/'), '')
  assert.equal(chrome.keepsIcons, true)
  assert.match(await chrome.iconOf('https://a.example/x'), /^data:image\/png;base64,/)
  assert.deepEqual(take(), [['fetch', 'chrome-extension://id/_favicon/?pageUrl=https%3A%2F%2Fa.example%2Fx&size=64']])
  favicon = new Response('', { status: 404 })
  assert.equal(await chrome.iconOf('https://a.example/'), '')
  favicon = new Error('offline')
  assert.equal(await chrome.iconOf('https://a.example/'), '')
  take()
})

test('Firefox asks to send sync data too, and starts sync only when allowed', async () => {
  granted = true
  assert.equal(await firefox.askSyncAccess(), true)
  granted = false
  assert.equal(await firefox.askSyncAccess(), false)
  await firefox.dropSyncAccess()
  assert.deepEqual(take(), [
    ['request', { ...ALL_SITES, data_collection: SYNC_DATA }],
    ['request', { ...ALL_SITES, data_collection: SYNC_DATA }],
    ['remove', { data_collection: SYNC_DATA }]
  ])
})

test('Chrome asks for site access only, and starts sync either way', async () => {
  granted = false
  assert.equal(await chrome.askSyncAccess(), true)
  await chrome.dropSyncAccess()
  assert.deepEqual(take(), [['request', ALL_SITES]])
})

test('menus, closed sites and the page API differ by browser', () => {
  assert.deepEqual(firefox.menuContexts, ['all', 'tab'])
  assert.deepEqual(chrome.menuContexts, ['all'])
  assert.equal(firefox.closedSites.size, 0)
  assert.ok(chrome.closedSites.has('https://chromewebstore.google.com'))
  assert.equal(firefox.pageApi, 'browser')
  assert.equal(chrome.pageApi, 'chrome')
  assert.equal(chromeFor('Brave').product, 'Brave')
})

test('a refused or failed question: Firefox starts no sync, Chrome starts it anyway', async () => {
  const request = fake.permissions.request
  fake.permissions.request = () => Promise.reject(new Error('no user gesture'))
  assert.equal(await firefox.askSyncAccess(), false)
  assert.equal(await chrome.askSyncAccess(), true)
  fake.permissions.request = request
})

test('what Firefox sync asks to send, and to which sites', () => {
  assert.deepEqual(SYNC_DATA, ['bookmarksInfo', 'websiteContent'])
  assert.deepEqual(ALL_SITES, { origins: ['<all_urls>'] })
})

test('steps a browser skips still answer as promises', () => {
  for (const each of [firefox.noteOnPage(() => Promise.resolve()), firefox.backTo(undefined), firefox.dropSyncAccess(), chrome.dropSyncAccess()]) {
    assert.ok(each instanceof Promise)
  }
})

test('the browser as the user knows it, for its device name', () => {
  assert.equal(firefox.product, 'Firefox')
})

test('Firefox without a list of engines has none to offer', async () => {
  assert.deepEqual(await firefox.searchEngines({ query: () => Promise.resolve(), search: () => Promise.resolve() }), [])
})

test("Edge's icon copies come without a type: they're PNGs", async () => {
  favicon = new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  assert.match(await edge.iconOf('https://a.example/'), /^data:image\/png;base64,/)
  take()
})

test('Edge is Chrome but for its product name and its closed store', () => {
  assert.equal(edge.product, 'Edge')
  assert.deepEqual([...edge.closedSites], ['https://microsoftedge.microsoft.com'])
  assert.equal(edge.previewInFront, true)
  assert.equal(edge.keepsIcons, true)
  assert.deepEqual(edge.menuContexts, ['all'])
})
