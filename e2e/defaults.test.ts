// A fresh install: FireDial starts with the views and sparks in src/defaults.json, each spark with its image.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import type firefox from 'selenium-webdriver/firefox.js'
import * as z from 'zod/mini'

import { installFireDial, NEWTAB, startFirefox, until } from './firefox.ts'

const defaults = z
  .object({ views: z.array(z.object({ title: z.string() })), sparks: z.array(z.object({ title: z.string() })) })
  .parse(JSON.parse(readFileSync('src/defaults.json', 'utf8')))
const titles = defaults.sparks.map((spark) => spark.title)
let driver: firefox.Driver

const js = <T>(code: string): Promise<T> => driver.executeScript<T>(code)
const stored = <T>(key: string): Promise<T> =>
  driver.executeAsyncScript<T>('const [key, done] = arguments; browser.storage.local.get(key).then((found) => done(found[key]))', key)

before(async () => {
  driver = startFirefox()
  await installFireDial(driver, { defaults: true })
  await driver.get(NEWTAB)
})

after(async () => {
  await driver.quit()
})

test('a fresh install starts with the default views and sparks, each with its image, and shows All', async () => {
  await until(
    driver,
    'the images',
    async () => (await js<number>("return document.querySelectorAll('#sparks .Spark[data-id] .Thumb img').length")) === titles.length
  )
  assert.deepEqual(
    (await stored<{ title: string }[]>('views')).map((view) => view.title),
    defaults.views.map((view) => view.title)
  )
  assert.deepEqual(
    (await stored<{ title: string }[]>('sparks')).map((spark) => spark.title),
    titles
  )
  const wikipedia = (await stored<{ title: string; labels: string[] }[]>('sparks')).find((spark) => spark.title === 'Wikipedia')
  assert.deepEqual(wikipedia?.labels, ['Open Web', 'knowledge', 'wiki'], 'with their labels')
})

test('the defaults are bookmarks too', async () => {
  const bookmarks = (): Promise<string[]> =>
    driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1]
    browser.bookmarks.search({ title: 'FireDial' }).then(async ([root]) => done(root ? (await browser.bookmarks.getSubTree(root.id))[0].children.filter((node) => !node.url.startsWith('https://firedial.invalid/')).map((node) => node.title) : []))`)
  await until(driver, 'the bookmarks', async () => (await bookmarks()).length === titles.length)
  assert.deepEqual(await bookmarks(), titles)
})
