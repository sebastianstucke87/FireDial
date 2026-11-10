// A fresh install: FireDial starts with the groups and sparks in src/defaults.json, each spark with its image.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import type firefox from 'selenium-webdriver/firefox.js'
import * as z from 'zod/mini'

import { installFireDial, NEWTAB, startFirefox, until } from './firefox.ts'

const defaults = z
  .object({ groups: z.array(z.object({ id: z.number(), title: z.string() })), sparks: z.array(z.object({ groupId: z.number(), title: z.string() })) })
  .parse(JSON.parse(readFileSync('src/defaults.json', 'utf8')))
const titles = defaults.sparks.map((spark) => spark.title)
const firstGroup = defaults.sparks.filter((spark) => spark.groupId === defaults.groups[0]?.id).length // the group shown
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

test('a fresh install starts with the default group and sparks, each with its image', async () => {
  await until(
    driver,
    'the images',
    async () => (await js<number>("return document.querySelectorAll('#sparks .Spark[data-id] .Thumb img').length")) === firstGroup
  )
  assert.deepEqual(
    (await stored<{ title: string }[]>('groups')).map((group) => group.title),
    defaults.groups.map((group) => group.title)
  )
  assert.deepEqual(
    (await stored<{ title: string }[]>('sparks')).map((spark) => spark.title),
    titles
  )
})

test('the defaults are bookmarks too', async () => {
  const bookmarks = (): Promise<string[]> =>
    driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1]
    browser.bookmarks.search({ title: 'FireDial' }).then(async ([root]) => done(root ? (await browser.bookmarks.getSubTree(root.id))[0].children.flatMap((node) => node.children ?? []).map((node) => node.title) : []))`)
  await until(driver, 'the bookmarks', async () => (await bookmarks()).length === titles.length)
  assert.deepEqual(await bookmarks(), titles)
})
