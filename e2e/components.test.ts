// Each component on its own, in a real Firefox: a blank page with the page's stylesheet and the
// built modules, without the extension around them.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import { Key } from 'selenium-webdriver'
import type { WebElement } from 'selenium-webdriver'
import type firefox from 'selenium-webdriver/firefox.js'
import { startFirefox, until as untilIn } from './firefox.ts'

const PAGE = `<!doctype html>
<html data-theme="light" data-color="firedial"><head><link rel="stylesheet" href="/newtab.css"></head>
<body>
  <dialog class="Modal" id="dialog"><form method="dialog"><span class="Input"><input id="inDialog"></span><div id="pickInDialog"></div><button class="save">Save</button><button type="button" class="cancel" data-close>Cancel</button></form></dialog>
  <div id="pick" style="width: 200px; margin: 40px"></div>
  <label class="Input" id="box" style="width: 300px"><input id="text"></label>
  <input id="inline">
  <button id="other">Other</button>
  <script type="module" src="/components.js"></script>
</body></html>`

// The components alone, bundled for the page above.
const COMPONENTS = `
  import { clearable } from './clearable.ts'
  import { Confirm } from './confirm.ts'
  import { Dropdown } from './dropdown.ts'
  import { editable } from './editable.ts'
  import { Modal } from './modal.ts'
  import { showToast, toastArgs } from './toast.ts'
  Object.assign(window, { clearable, Confirm, Dropdown, editable, Modal, showToast, toastArgs })
  window.log = []
  window.ready = true
`

const bundled = await build({ stdin: { contents: COMPONENTS, resolveDir: 'src/ui', loader: 'ts' }, bundle: true, format: 'esm', write: false })

const TYPES: Readonly<Record<string, string>> = { '.css': 'text/css', '.js': 'text/javascript' }

const server = createServer((request, response) => {
  const url = request.url ?? ''
  if (url === '/') {
    response.setHeader('content-type', 'text/html')
    response.end(PAGE)
    return
  }
  if (url === '/components.js') {
    response.setHeader('content-type', 'text/javascript')
    response.end(bundled.outputFiles[0]?.text)
    return
  }
  try {
    const file = readFileSync(join('dist/firefox', normalize(url)))
    response.setHeader('content-type', TYPES[extname(url)] ?? 'text/plain')
    response.end(file)
  } catch {
    response.statusCode = 404
    response.end()
  }
}).listen(0, '127.0.0.1')

let driver: firefox.Driver
let base = ''

const js = <T>(code: string, ...args: unknown[]): Promise<T> => driver.executeScript<T>(code, ...args)
const press = (...keys: string[]): Promise<void> =>
  driver
    .actions()
    .sendKeys(...keys)
    .perform()
const until = (what: string, check: () => Promise<boolean>): Promise<void> => untilIn(driver, what, check)
const find = (selector: string): Promise<WebElement> => driver.findElement({ css: selector })
const click = async (selector: string): Promise<void> => {
  await (await find(selector)).click()
}

before(async () => {
  await new Promise((resolve) => server.once('listening', resolve))
  const address: string | AddressInfo | null = server.address()
  assert.ok(address !== null && typeof address === 'object')
  base = `http://127.0.0.1:${address.port}/`
  driver = startFirefox()
  await driver.manage().window().setRect({ width: 900, height: 700 })
})

after(async () => {
  await driver.quit()
  server.close()
})

async function page(setup: string): Promise<void> {
  await driver.get(base)
  await until('the modules', () => js('return window.ready === true'))
  await js(setup)
}

// Modal

const openModal = async (dismissible: boolean): Promise<void> => {
  await page(`
    window.modal = new Modal(document.querySelector('#dialog'), 'A title', ${dismissible})
    modal.open().then((result) => log.push(['closed', result]))
  `)
}
const isOpen = (): Promise<boolean> => js("return document.querySelector('#dialog').open")
const logged = (): Promise<unknown[]> => js('return window.log')

test('modal: flame, title and close button come from the component', async () => {
  await openModal(true)
  assert.equal(await js("return document.querySelector('.Modal__title').textContent"), 'A title')
  assert.equal(await js("return document.querySelector('.Modal__title use').getAttribute('href')"), '#i-flame')
  assert.ok(await js("return !document.querySelector('.Modal__close').hidden"))
  assert.equal(await js("return document.querySelector('#dialog').getAttribute('aria-label')"), 'A title')
  assert.equal(await js("return getComputedStyle(document.querySelector('#dialog')).outlineStyle"), 'none')
  await js("modal.title = 'Another'")
  assert.equal(await js("return document.querySelector('.Modal__title').textContent"), 'Another')
})

test('modal: submitting resolves save, every way out resolves empty', async () => {
  await openModal(true)
  await click('.save')
  await until('the result', async () => (await logged()).length === 1)
  assert.deepEqual(await logged(), [['closed', 'save']])
  for (const leave of [(): Promise<void> => press(Key.ESCAPE), (): Promise<void> => click('.Modal__close'), (): Promise<void> => click('.cancel')]) {
    await openModal(true)
    await leave()
    await until('the result', async () => (await logged()).length === 1)
    assert.deepEqual(await logged(), [['closed', '']])
  }
})

test("modal: Esc stays with the modal, the page behind it doesn't hear it", async () => {
  await openModal(true)
  await js("document.addEventListener('keydown', () => log.push('page'))")
  await press(Key.ESCAPE)
  await until('the result', async () => (await logged()).length === 1)
  assert.deepEqual(await logged(), [['closed', '']])
})

test("modal: one that can't be dismissed has no close button and ignores Esc, until it can", async () => {
  await openModal(false)
  assert.ok(await js("return document.querySelector('.Modal__close').hidden"))
  await press(Key.ESCAPE)
  await driver.sleep(100)
  assert.ok(await isOpen())
  await js('modal.dismissible = true')
  assert.ok(await js("return !document.querySelector('.Modal__close').hidden"))
  await press(Key.ESCAPE)
  await until('the dialog to close', async () => !(await isOpen()))
})

// Confirm

const ask = (): Promise<void> =>
  js(`
  window.answer = 'none'
  confirmModal.ask({ title: 'Sure?', text: 'It goes', button: 'Do it' }).then((yes) => { window.answer = yes })
`)
const answer = (): Promise<unknown> => js('return window.answer')

test('confirm: the button waits for the checkbox, and asks from the start every time', async () => {
  await page('window.confirmModal = new Confirm()')
  await ask()
  assert.equal(await js('return document.querySelector(\'dialog.Modal[aria-label="Sure?"] .Modal__title\').textContent'), 'Sure?')
  assert.equal(await js("return document.querySelector('.Confirm').textContent"), 'It goes')
  assert.equal(await js("return document.querySelector('dialog[aria-label=\"Sure?\"] .Button--primary use').getAttribute('href')"), '#i-alert')
  const button = await find('dialog[aria-label="Sure?"] .Button--primary')
  assert.equal(await button.getText(), 'Do it')
  assert.equal(await button.isEnabled(), false)
  await click('.Confirm input')
  assert.equal(await button.isEnabled(), true)
  await click('.Confirm input')
  assert.equal(await button.isEnabled(), false)
  await click('.Confirm input')
  await button.click()
  await until('the answer', async () => (await answer()) === true)
  await ask()
  assert.equal(await button.isEnabled(), false)
  assert.ok(await js("return !document.querySelector('.Confirm input').checked"))
  await press(Key.ESCAPE)
  await until('the answer', async () => (await answer()) === false)
})

// Dropdown

const CHOICES = "[{ value: 1, label: 'One' }, { value: 2, label: 'Two' }, { value: 3, label: 'Three' }]"
const opened = (root: string): Promise<boolean> => js(`return !document.querySelector('${root} .Dropdown__list').hidden`)

test('dropdown: shows the value, the list hangs on the button, a pick reports back', async () => {
  await page(`
    window.pick = new Dropdown(document.querySelector('#pick'), 'Numbers', (value) => log.push(value))
    pick.setChoices(${CHOICES}, 2)
  `)
  assert.equal(await (await find('#pick .Dropdown__button')).getText(), 'Two')
  assert.equal(await opened('#pick'), false)
  await click('#pick .Dropdown__button')
  assert.equal(await opened('#pick'), true)
  const box = await js<number[]>(`
    const [button, list] = [document.querySelector('#pick .Dropdown__button').getBoundingClientRect(), document.querySelector('#pick .Dropdown__list').getBoundingClientRect()]
    return [list.top - button.bottom, list.left - button.left, list.width - button.width]`)
  assert.deepEqual(box, [-2, 0, 0])
  assert.equal(await js('return document.activeElement.textContent'), 'Two')
  assert.equal(await js('return document.querySelector(\'[aria-selected="true"]\').textContent'), 'Two')
  await click('#pick .Dropdown__option:nth-child(3)')
  assert.equal(await opened('#pick'), false)
  assert.equal(await (await find('#pick .Dropdown__button')).getText(), 'Three')
  assert.equal(await js('return pick.value'), 3)
  assert.deepEqual(await logged(), [3])
})

test('dropdown: works by keyboard, and a click elsewhere closes it', async () => {
  await page(`new Dropdown(document.querySelector('#pick'), 'Numbers', (value) => log.push(value)).setChoices(${CHOICES}, 1)`)
  await (await find('#pick .Dropdown__button')).sendKeys(Key.ARROW_DOWN)
  assert.equal(await opened('#pick'), true)
  await press(Key.ARROW_DOWN)
  assert.equal(await js('return document.activeElement.textContent'), 'Two')
  await press(Key.ARROW_UP, Key.ARROW_UP)
  assert.equal(await js('return document.activeElement.textContent'), 'Three')
  await press(Key.ENTER)
  assert.deepEqual(await logged(), [3])
  assert.equal(await js('return document.activeElement.className'), 'Dropdown__button')
  await press(Key.ARROW_DOWN)
  await press(Key.ESCAPE)
  assert.equal(await opened('#pick'), false)
  await click('#pick .Dropdown__button')
  await driver.actions().move({ x: 700, y: 600 }).click().perform()
  assert.equal(await opened('#pick'), false)
})

test("dropdown: in a modal it isn't cut off, and Esc closes only the list", async () => {
  await page(`
    window.modal = new Modal(document.querySelector('#dialog'), 'A title')
    new Dropdown(document.querySelector('#pickInDialog'), 'Numbers').setChoices(${CHOICES}, 1)
    modal.open()
  `)
  await click('#pickInDialog .Dropdown__button')
  const hit = await js<boolean>(`
    const option = document.querySelector('#pickInDialog .Dropdown__option:last-child')
    const { left, top, width, height } = option.getBoundingClientRect()
    return document.elementFromPoint(left + width / 2, top + height / 2) === option`)
  assert.ok(hit, 'the last option is on top')
  await press(Key.ESCAPE)
  assert.equal(await opened('#pickInDialog'), false)
  assert.ok(await isOpen())
  await press(Key.ESCAPE)
  await until('the dialog to close', async () => !(await isOpen()))
})

test('dropdown: at the bottom of the window it opens upward', async () => {
  await page(`
    const pick = document.querySelector('#pick')
    pick.style.cssText = 'position: fixed; left: 40px; bottom: 20px; width: 200px; margin: 0'
    new Dropdown(pick, 'Numbers').setChoices(${CHOICES}, 1)
  `)
  await click('#pick .Dropdown__button')
  const box = await js<number[]>(`
    const [button, list] = [document.querySelector('#pick .Dropdown__button').getBoundingClientRect(), document.querySelector('#pick .Dropdown__list').getBoundingClientRect()]
    return [button.top - list.bottom, list.top > 0 ? 1 : 0]`)
  assert.deepEqual(box, [-2, 1])
  assert.ok(await js("return document.querySelector('#pick').classList.contains('Dropdown--up')"))
})

// Clear strip

test('clear strip: there while there is text, fills the end of the field, empties it like typing', async () => {
  await page(`
    const input = document.querySelector('#text')
    window.refresh = clearable(input)
    input.addEventListener('input', () => log.push(input.value))
  `)
  assert.ok(await js("return document.querySelector('.Clear').hidden"))
  await (await find('#text')).sendKeys('a')
  assert.ok(await js("return !document.querySelector('.Clear').hidden"))
  const box = await js<number[]>(`
    const [strip, field] = [document.querySelector('.Clear').getBoundingClientRect(), document.querySelector('#box')]
    const inner = field.getBoundingClientRect()
    return [strip.height - field.clientHeight, inner.right - strip.right - field.clientLeft, strip.width >= 36 ? 1 : 0]`)
  assert.deepEqual(box, [0, 0, 1])
  await click('.Clear')
  assert.equal(await js("return document.querySelector('#text').value"), '')
  assert.ok(await js("return document.querySelector('.Clear').hidden"))
  assert.equal(await js('return document.activeElement.id'), 'text')
  assert.deepEqual(await logged(), ['a', ''])
  await js("document.querySelector('#text').value = 'set by code'; refresh()")
  assert.ok(await js("return !document.querySelector('.Clear').hidden"))
})

// Text in place

test('editable: Enter and leaving save, Esc cancels, keys stay inside', async () => {
  await page(`
    const input = document.querySelector('#inline')
    editable(input, () => log.push('save'), () => log.push('cancel'))
    document.addEventListener('keydown', () => log.push('leaked'))
  `)
  const input = await find('#inline')
  await input.sendKeys('a', Key.ENTER)
  assert.deepEqual(await logged(), ['save'])
  await input.click()
  await input.sendKeys(Key.ESCAPE)
  assert.deepEqual(await logged(), ['save', 'cancel', 'save'])
  await input.click()
  await click('#other')
  assert.deepEqual(await logged(), ['save', 'cancel', 'save', 'save'])
})

// Notification

const toast = async (): Promise<WebElement> => {
  const root = await (await find('#firedial-toasts > :last-child')).getShadowRoot()
  return root.findElement({ css: 'div' })
}
const toasts = (): Promise<number> => js("return document.querySelectorAll('#firedial-toasts > *').length")
const prefs = "{ color: 'ocean', customColor: '#000000' }"

test('notification: flame, text and dismiss button in the chosen color', async () => {
  await page(`showToast(...toastArgs('Hello', ${prefs}))`)
  const element = await toast()
  assert.equal((await element.getText()).split('\n')[0], 'Hello')
  assert.equal(await element.getCssValue('background-color'), 'rgb(29, 78, 216)')
  assert.equal(await element.getCssValue('color'), 'rgb(255, 255, 255)')
  assert.deepEqual(
    await js(
      "const { right, bottom } = document.querySelector('#firedial-toasts').getBoundingClientRect(); return [document.documentElement.clientWidth - right, innerHeight - bottom].map(Math.round)"
    ),
    [16, 16]
  )
  await (await element.findElement({ css: 'button' })).click()
  assert.equal(await toasts(), 0)
})

test('notification: without a destination a click does nothing, and it ends by itself', async () => {
  await page(`showToast('Hello', 400, '#000000', '#ffffff', null)`)
  await (await (await toast()).findElement({ css: 'span' })).click()
  assert.equal(await toasts(), 1)
  await until('it to end', async () => (await toasts()) === 0)
})

test('notification: several stack without overlapping, three at most, the newest last', async () => {
  await page(`for (const text of ['First', 'Second', 'Third', 'Fourth']) showToast(...toastArgs(text, ${prefs}))`)
  assert.equal(await toasts(), 3)
  assert.equal((await (await toast()).getText()).split('\n')[0], 'Fourth')
  const gaps = await js<number[]>(`
    const boxes = [...document.querySelectorAll('#firedial-toasts > *')].map((host) => host.getBoundingClientRect())
    return boxes.slice(1).map((box, index) => box.top - boxes[index].bottom)`)
  assert.deepEqual(gaps, [8, 8])
})
