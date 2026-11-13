// Firefox's bookmarks into FireDial, in a real Firefox: a label from each folder, a view from each top
// folder, the icons from a local site, and a second import that adds nothing.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { By } from 'selenium-webdriver'
import type firefox from 'selenium-webdriver/firefox.js'
import { installFireDial, NEWTAB, startFirefox, until as untilIn } from './firefox.ts'

// 2×2 orange pixels.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8DwnwEJMDKgCgAAWAUD/2Tz1qcAAAAASUVORK5CYII=', 'base64')

const asked: string[] = []
const server = createServer((request, response) => {
  asked.push(request.url ?? '')
  if (request.url === '/icon.png') {
    response.setHeader('content-type', 'image/png')
    response.end(PNG)
    return
  }
  response.setHeader('content-type', 'text/html')
  response.end('<!doctype html><title>Site</title><link rel="icon" href="/icon.png">')
}).listen(0, '127.0.0.1')

let driver: firefox.Driver
let base = ''

const js = <T>(code: string, ...args: unknown[]): Promise<T> => driver.executeScript<T>(code, ...args)
const until = (what: string, check: () => Promise<boolean>): Promise<void> => untilIn(driver, what, check)
const openDialogs = (): Promise<string[]> => js("return [...document.querySelectorAll('dialog[open]')].map((dialog) => dialog.getAttribute('aria-label'))")
const viewNames = (): Promise<string[]> => js("return [...document.querySelectorAll('.Group .Name')].map((name) => name.textContent)")

async function notifications(): Promise<string[]> {
  const hosts = await driver.findElements(By.css('#firedial-toasts > *'))
  return Promise.all(hosts.map(async (host) => (await (await host.getShadowRoot()).findElement(By.css('span'))).getText()))
}

async function startImport(): Promise<void> {
  await js('document.querySelector(\'[data-action="about"]\').click()')
  await until('About', async () => (await openDialogs()).join() === 'FireDial')
  await driver.findElement(By.css('[data-action="import-bookmarks"]')).click()
}

before(async () => {
  await new Promise((resolve) => server.once('listening', resolve))
  const address: string | AddressInfo | null = server.address()
  assert.ok(address !== null && typeof address === 'object')
  base = `http://127.0.0.1:${address.port}`
  driver = startFirefox({ 'extensions.webextOptionalPermissionPrompts': false })
  await installFireDial(driver)
  await driver.manage().window().setRect({ width: 1400, height: 900 })
  await driver.get(NEWTAB)
  await until('the page', () => js("return document.querySelector('#sparks .AddSpark') !== null"))
  await driver.executeAsyncScript(
    `
    const [base, done] = arguments
    ;(async () => {
      for (const area of ['toolbar_____', 'menu________', 'unfiled_____', 'mobile______']) {
        for (const node of await browser.bookmarks.getChildren(area)) {
          if (node.title !== 'FireDial') await browser.bookmarks.removeTree(node.id) // Firefox's own
        }
      }
      const work = await browser.bookmarks.create({ parentId: 'toolbar_____', title: 'Work' })
      await browser.bookmarks.create({ parentId: work.id, title: 'Board', url: base + '/board' })
      const docs = await browser.bookmarks.create({ parentId: work.id, title: 'Docs' })
      await browser.bookmarks.create({ parentId: docs.id, title: 'Ref', url: base + '/ref' })
      await browser.bookmarks.create({ parentId: 'toolbar_____', title: 'Loose', url: base + '/loose' })
    })().then(done)`,
    base
  )
})

after(async () => {
  await driver.quit()
  server.close()
})

test('an import asks with numbers, makes labels and views, then loads the icons from the site', async () => {
  await startImport()
  await until('the question', async () => (await openDialogs()).join() === 'Import bookmarks')
  assert.match(await js<string>("return document.querySelector('dialog[open] .Confirm').textContent"), /^Import 3 bookmarks from 3 folders\./)
  await driver.findElement(By.css('dialog[open] .Confirm input')).click()
  await driver.findElement(By.css('dialog[open] .Button--primary')).click()
  await until('the views', async () => (await viewNames()).join() === 'All,Unlabeled,Work')
  await until('the icons', () => js("return browser.storage.local.get('sparks').then(({ sparks }) => sparks.every((spark) => spark.thumb !== null))"))
  assert.deepEqual(await notifications(), ['Imported 3 bookmarks, 1 new view'])
  const sparks = await js<{ title: string; labels: string[]; thumb: boolean }[]>(`
    return browser.storage.local.get('sparks').then(({ sparks }) => sparks.map((spark) => ({ title: spark.title, labels: spark.labels, thumb: spark.thumb !== null })))`)
  assert.deepEqual(sparks, [
    { title: 'Board', labels: ['Work'], thumb: true },
    { title: 'Ref', labels: ['Work', 'Docs'], thumb: true },
    { title: 'Loose', labels: [], thumb: true }
  ])
  assert.ok(asked.includes('/icon.png'))
  assert.equal(await js('return browser.permissions.contains({ origins: ["<all_urls>"] })'), false, 'the access ends with the import')
})

test('a second import adds nothing, and undo takes the icons, then the import back', async () => {
  await js("document.querySelector('#firedial-toasts')?.remove()")
  await startImport()
  await until('the answer', async () => (await driver.findElements(By.css('#firedial-toasts'))).length > 0)
  assert.deepEqual(await notifications(), ['Nothing new to import'])
  assert.deepEqual(await openDialogs(), [], 'no question, and no access asked for')
  await js("document.querySelector('#editToggle').click()")
  await js("document.querySelector('#undo').click()")
  await until('no icons', () => js("return browser.storage.local.get('sparks').then(({ sparks }) => sparks.every((spark) => spark.thumb === null))"))
  await js("document.querySelector('#undo').click()")
  await until('only All and Unlabeled', async () => (await viewNames()).join() === 'All,Unlabeled')
})

test('a bookmark added in Firefox after an import is new to the next one', async () => {
  await startImport()
  await until('the question', async () => (await openDialogs()).join() === 'Import bookmarks')
  await driver.findElement(By.css('dialog[open] .Confirm input')).click()
  await driver.findElement(By.css('dialog[open] .Button--primary')).click()
  await until('the views', async () => (await viewNames()).join() === 'All,Unlabeled,Work')
  await driver.executeAsyncScript(
    `
    const [base, done] = arguments
    browser.bookmarks.create({ parentId: 'toolbar_____', title: 'Later', url: base + '/later' }).then(() => done())`,
    base
  )
  await startImport()
  await until('the question', async () => (await openDialogs()).join() === 'Import bookmarks')
  assert.match(
    await js<string>("return document.querySelector('dialog[open] .Confirm').textContent"),
    /^Import 1 bookmark from 1 folder \(3 are in FireDial already\)\./
  )
  await js("document.querySelector('dialog[open] [data-close]').click()")
})
