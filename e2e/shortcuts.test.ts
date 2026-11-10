// Every shortcut in the About dialog, tried in a real Firefox with a throwaway profile. The list
// comes from the dialog itself: a shortcut without a test here fails, and so does a test without
// a shortcut. Run with `npm run e2e`.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { Button, By, Key } from 'selenium-webdriver'
import type { WebElement } from 'selenium-webdriver'
import firefox from 'selenium-webdriver/firefox.js'
import { installFireDial, NEWTAB, startFirefox, until as untilIn } from './firefox.ts'

const SPARKS = 7

const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html')
  response.end(`<!doctype html><title>${request.url ?? ''}</title>`)
}).listen(0, '127.0.0.1')

let driver: firefox.Driver
let base = ''

const js = <T>(code: string, ...args: unknown[]): Promise<T> => driver.executeScript<T>(code, ...args)
const press = (...keys: string[]): Promise<void> =>
  driver
    .actions()
    .sendKeys(...keys)
    .perform()
const chord = (modifier: string, key: string): Promise<void> => driver.actions().keyDown(modifier).sendKeys(key).keyUp(modifier).perform()
const clickWith = (modifier: string, element: WebElement): Promise<void> => driver.actions().keyDown(modifier).click(element).keyUp(modifier).perform()
const tile = (index: number): Promise<WebElement> => driver.findElement(By.css(`#sparks .Spark[data-id]:nth-child(${index + 1})`))
const sparkCount = (): Promise<number> => js("return document.querySelectorAll('#sparks .Spark[data-id]').length")
const selectedCount = (): Promise<number> => js("return document.querySelectorAll('.Spark--selected').length")
const focusedIndex = (): Promise<number> => js("return [...document.querySelectorAll('#sparks .Spark')].indexOf(document.activeElement)")
const focusSpark = (index: number): Promise<void> => js(`document.querySelectorAll('#sparks .Spark')[${index}].focus()`)
const clickEdit = async (): Promise<void> => {
  await (await driver.findElement(By.id('editToggle'))).click()
}

const until = (what: string, check: () => Promise<boolean>): Promise<void> => untilIn(driver, what, check)
const sparksAre = (count: number): Promise<void> => until(`${count} sparks`, async () => (await sparkCount()) === count)

async function home(): Promise<void> {
  await driver.get(NEWTAB)
  await until('the sparks', async () => (await sparkCount()) > 0)
}

// Runs the click, expects a new tab with the spark's page, and closes it again.
async function expectNewTab(click: () => Promise<void>, index: number): Promise<void> {
  const before = await driver.getAllWindowHandles()
  await click()
  await until('a new tab', async () => (await driver.getAllWindowHandles()).length === before.length + 1)
  const handles = await driver.getAllWindowHandles()
  const opened = handles.find((handle) => !before.includes(handle))
  assert.ok(opened)
  const [current] = before
  assert.ok(current)
  await driver.switchTo().window(opened)
  await until('the page', async () => (await driver.getCurrentUrl()) === `${base}/${index}`)
  await driver.close()
  await driver.switchTo().window(current)
}

const shortcuts: Record<string, () => Promise<void>> = {
  '/': async () => {
    await press('/')
    assert.equal(await js('return document.activeElement.id'), 'search')
  },
  Enter: async () => {
    await focusSpark(1)
    await press(Key.ENTER)
    await until('the spark', async () => (await driver.getCurrentUrl()) === `${base}/1`)
    await home()
    await press('/', `${base}/2`)
    await until('the suggestion', () => js("return document.querySelector('.SuggestItem--active') !== null"))
    await press(Key.ENTER)
    await until('the suggested spark', async () => (await driver.getCurrentUrl()) === `${base}/2`)
  },
  Esc: async () => {
    await press('/', `${base}/2`)
    await sparksAre(1)
    await press(Key.ESCAPE)
    await sparksAre(SPARKS)
    await clickEdit()
    await (await tile(0)).click()
    assert.equal(await selectedCount(), 1)
    await press(Key.ESCAPE)
    assert.equal(await selectedCount(), 0)
    assert.ok(await js("return document.body.classList.contains('editing')"))
    await press(Key.ESCAPE)
    assert.ok(await js("return !document.body.classList.contains('editing')"))
  },
  '← ↑ → ↓': async () => {
    const columns = await js<number>("return getComputedStyle(document.querySelector('#sparks')).gridTemplateColumns.split(' ').length")
    await focusSpark(0)
    await press(Key.ARROW_RIGHT)
    assert.equal(await focusedIndex(), 1)
    await press(Key.ARROW_LEFT)
    assert.equal(await focusedIndex(), 0)
    await press(Key.ARROW_DOWN)
    assert.equal(await focusedIndex(), columns)
    await press(Key.ARROW_UP)
    assert.equal(await focusedIndex(), 0)
  },
  'Ctrl Z': async () => {
    await (await driver.findElement(By.css('#sparks .AddSpark'))).click()
    await press(`${base}/temporary`, Key.ENTER)
    await sparksAre(SPARKS + 1)
    await js('document.activeElement.blur()')
    await chord(Key.CONTROL, 'z')
    await driver.sleep(300)
    assert.equal(await sparkCount(), SPARKS + 1, "normal mode doesn't undo")
    await clickEdit()
    await chord(Key.CONTROL, 'z')
    await sparksAre(SPARKS)
  },
  'Ctrl Y': async () => {
    await chord(Key.CONTROL, 'y')
    await driver.sleep(300)
    assert.equal(await sparkCount(), SPARKS, "normal mode doesn't redo")
    await clickEdit()
    await chord(Key.CONTROL, 'y')
    await sparksAre(SPARKS + 1)
    await chord(Key.CONTROL, 'z')
    await sparksAre(SPARKS)
  },
  'Ctrl + click': async () => {
    const element = await tile(3)
    await expectNewTab(() => clickWith(Key.CONTROL, element), 3)
    assert.equal(await selectedCount(), 0)
  },
  'Mouse middle click': async () => {
    const element = await tile(4)
    await expectNewTab(() => driver.actions().move({ origin: element }).press(Button.MIDDLE).release(Button.MIDDLE).perform(), 4)
  },
  'Ctrl A': async () => {
    await js('document.activeElement.blur()')
    await chord(Key.CONTROL, 'a')
    assert.equal(await selectedCount(), 0, "normal mode doesn't select")
    await clickEdit()
    await chord(Key.CONTROL, 'a')
    assert.equal(await selectedCount(), SPARKS)
    await press(Key.ESCAPE)
  },
  'Shift + click': async () => {
    await clickEdit()
    await (await tile(1)).click()
    await clickWith(Key.SHIFT, await tile(3))
    assert.equal(await selectedCount(), 3)
    await press(Key.ESCAPE)
  },
  Del: async () => {
    await focusSpark(0)
    await press(Key.DELETE)
    assert.equal(await sparkCount(), SPARKS, "normal mode doesn't remove")
    await clickEdit()
    await (await tile(1)).click()
    await (await tile(2)).click()
    await press(Key.DELETE)
    await sparksAre(SPARKS - 2)
    await chord(Key.CONTROL, 'z')
    await sparksAre(SPARKS)
  }
}

before(async () => {
  await new Promise((resolve) => server.once('listening', resolve))
  const address: string | AddressInfo | null = server.address()
  assert.ok(address !== null && typeof address === 'object')
  base = `http://127.0.0.1:${address.port}`
  driver = startFirefox()
  await installFireDial(driver)
  await driver.manage().window().setRect({ width: 1400, height: 900 })
  await driver.get(NEWTAB)
  await until('the page', () => js("return document.querySelector('#sparks .AddSpark') !== null"))
  for (let index = 0; index < SPARKS; index++) {
    await (await driver.findElement(By.css('#sparks .AddSpark'))).click()
    await press(`${base}/${index}`, Key.ENTER)
    await sparksAre(index + 1)
  }
})

after(async () => {
  await driver.quit()
  server.close()
})

test('the search box opens a typed address', async () => {
  await home()
  await press('/', base.replace('http://', ''), '/5')
  await until('the Go to item', () => js("return document.querySelector('.SuggestItem--active')?.textContent.startsWith('Go to')"))
  await press(Key.ENTER)
  await until('the page', async () => (await driver.getCurrentUrl()) === `${base}/5`)
})

test('the dialog lists exactly the shortcuts tested here', async () => {
  await home()
  await clickEdit()
  await (await driver.findElement(By.css('[data-action="about"]'))).click()
  await until('the About dialog', () => js('return document.getElementById("aboutModal").open'))
  const documented = await js<string[]>("return [...document.querySelectorAll('.Keys dt')].map((node) => node.textContent.replace(/\\s+/g, ' ').trim())")
  assert.deepEqual([...documented].sort(), Object.keys(shortcuts).sort())
})

for (const [name, run] of Object.entries(shortcuts)) {
  test(`shortcut: ${name}`, async () => {
    await home()
    await run()
  })
}
