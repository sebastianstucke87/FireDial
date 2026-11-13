// Views and labels in a real Firefox: labels given in the spark dialog or to a selection across
// views, a view's filter edited with the grid following along, its order and sort, taking sparks
// out of a view, labels in the search, and deleting a view. The tests build on each other.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { By, Key } from 'selenium-webdriver'
import type { WebElement } from 'selenium-webdriver'
import type firefox from 'selenium-webdriver/firefox.js'
import { installFireDial, NEWTAB, startFirefox, until as untilIn } from './firefox.ts'

let driver: firefox.Driver

const js = <T>(code: string, ...args: unknown[]): Promise<T> => driver.executeScript<T>(code, ...args)
const press = (...keys: string[]): Promise<void> =>
  driver
    .actions()
    .sendKeys(...keys)
    .perform()
const until = (what: string, check: () => Promise<boolean>): Promise<void> => untilIn(driver, what, check)
const click = (selector: string): Promise<void> => js('document.querySelector(arguments[0]).click()', selector)
const sparkCount = (): Promise<number> => js("return document.querySelectorAll('#sparks .Spark[data-id]').length")
const sparkTitles = (): Promise<string[]> => js("return [...document.querySelectorAll('#sparks .Spark[data-id] .Title')].map((title) => title.textContent)")
const openDialogs = (): Promise<string[]> => js("return [...document.querySelectorAll('dialog[open]')].map((dialog) => dialog.getAttribute('aria-label'))")
const edit = (): Promise<void> => click('#editToggle')
const editing = (): Promise<boolean> => js("return document.querySelector('#app').classList.contains('App--options')")
const tileLabels = (): Promise<string[][]> =>
  js("return [...document.querySelectorAll('#sparks .Spark[data-id]')].map((tile) => [...tile.querySelectorAll('.Chip')].map((chip) => chip.dataset.label))")
const viewNames = (): Promise<string[]> => js("return [...document.querySelectorAll('.Group .Name')].map((name) => name.textContent)")
const stored = <T>(key: string): Promise<T> =>
  driver.executeAsyncScript<T>('const [key, done] = arguments; browser.storage.local.get(key).then((found) => done(found[key]))', key)

async function notification(): Promise<string> {
  await until('a notification', () => js("return document.querySelector('#firedial-toasts') !== null"))
  const host = await driver.findElement(By.css('#firedial-toasts > :last-child'))
  return (await (await host.getShadowRoot()).findElement(By.css('span'))).getText()
}

// The labels a chip field suggests, with their counts; picking one is a click on it.
const suggested = (root: string): Promise<string[]> =>
  js(
    "return [...document.querySelectorAll(arguments[0] + ' .SuggestItem')].filter((item) => item.checkVisibility()).map((item) => [item.dataset.label, item.querySelector('small')?.textContent].join(' ').trim())",
    root
  )
async function pick(root: string, label: string): Promise<void> {
  await driver.findElement(By.css(`${root} input`)).click()
  await js("[...document.querySelectorAll(arguments[0] + ' .SuggestItem')].find((item) => item.dataset.label === arguments[1]).click()", root, label)
}

const clearNotifications = (): Promise<void> => js("document.querySelector('#firedial-toasts')?.remove()")
const noNotification = (): Promise<boolean> => js("return document.querySelector('#firedial-toasts') === null")
const suggestions = (root: string): Promise<string[]> =>
  js("return [...document.querySelectorAll(arguments[0] + ' .SuggestItem')].filter((item) => item.checkVisibility()).map((item) => item.dataset.label)", root)

async function addSpark(url: string): Promise<void> {
  const before = await sparkCount()
  await driver.findElement(By.css('#sparks .AddSpark')).click()
  await press(url, Key.ENTER)
  await until('the spark', async () => (await sparkCount()) === before + 1)
}

async function addView(name: string): Promise<void> {
  await click('#newGroup')
  await press(name, Key.ENTER)
  await until('the view', () => js("return document.querySelector('.Group--active .Name').textContent === arguments[0]", name))
}

const showView = async (name: string): Promise<void> => {
  const index = (await viewNames()).indexOf(name)
  assert.ok(index >= 0, name)
  await js('document.querySelectorAll(".Group")[arguments[0]].click()', index)
  await until(name, () => js("return document.querySelector('.Group--active .Name').textContent === arguments[0]", name))
}

async function contextMenu(selector: string, entry: string): Promise<void> {
  const element: WebElement = await driver.findElement(By.css(selector))
  await driver.actions().contextClick(element).perform()
  await js("[...document.querySelectorAll('.ContextMenu__item')].find((item) => item.textContent === arguments[0]).click()", entry)
}

// A spot on the view row with this name, for the context menu.
const row = async (name: string): Promise<string> => `.Group:nth-child(${(await viewNames()).indexOf(name) + 1}) small` // not the name: in Edit it is a text field

before(async () => {
  driver = startFirefox()
  await installFireDial(driver)
  await driver.manage().window().setRect({ width: 1400, height: 900 })
  await driver.get(NEWTAB)
  await until('the page', () => js("return document.querySelector('#sparks .AddSpark') !== null"))
  assert.deepEqual(await viewNames(), ['All', 'Unlabeled'], 'a fresh FireDial has its two views')
  await addSpark('https://alpha.example/')
  await addSpark('https://beta.example/')
  await edit()
  await addView('Work')
  await addSpark('https://gamma.example/')
  assert.equal(
    await js("return document.documentElement.dataset.labels + ' ' + document.documentElement.dataset.labelColor"),
    'on monochrome',
    'labels start shown, in grey'
  )
  await showView('All')
})

after(async () => {
  await driver.quit()
})

test('a spark added in a view carries its label, and Unlabeled has the others', async () => {
  assert.deepEqual(await tileLabels(), [[], [], ['Work']])
  await showView('Unlabeled')
  assert.deepEqual(await sparkTitles(), ['alpha.example', 'beta.example'])
  await showView('All')
})

test('the spark dialog adds labels as chips, split by commas, as written', async () => {
  await js("document.querySelector('#sparks .Spark[data-id] .EditSpark').click()")
  await until('Edit', async () => (await openDialogs()).join() === 'Edit')
  await driver.findElement(By.css('#sparkLabels input')).click()
  assert.deepEqual(await suggestions('#sparkLabels'), ['Work'], 'the known labels, before typing')
  await press('Trip to Rome, news', Key.ENTER)
  await press('trip TO rome', Key.ENTER)
  assert.deepEqual(
    await js("return [...document.querySelectorAll('#sparkLabels .Chip')].map((chip) => chip.dataset.label)"),
    ['news', 'Trip to Rome'],
    'A to Z'
  )
  await click('#sparkLabels [data-remove="news"]')
  await click('#sparkSave')
  await until('the dialog to close', async () => (await openDialogs()).length === 0)
  await until('the chip', async () => (await tileLabels())[0]?.join() === 'Trip to Rome')
})

test('a new spark in the dialog starts with the open view as its label', async () => {
  await showView('Work')
  await contextMenu('#main', 'New spark')
  await until('Add spark', async () => (await openDialogs()).join() === 'Add spark')
  assert.deepEqual(await js("return [...document.querySelectorAll('#sparkLabels .Chip')].map((chip) => chip.dataset.label)"), ['Work'])
  await press(Key.ESCAPE)
  await showView('All')
})

test('a selection across two views gets a label at once, and one undo takes it back', async () => {
  assert.ok(await editing())
  await clearNotifications()
  await js("document.querySelectorAll('#sparks .Spark[data-id]')[1].click()")
  await showView('Work')
  await js("document.querySelectorAll('#sparks .Spark[data-id]')[0].click()")
  assert.equal(await js("return document.querySelector('#labelBulk').hidden"), false)
  assert.match(await js<string>("return document.querySelector('#trash').textContent"), /Delete 2/)
  await click('#labelBulk')
  await until('Labels', async () => (await openDialogs()).join() === 'Labels')
  await driver.findElement(By.css('#bulkLabels input')).click()
  await press('we')
  assert.deepEqual(await suggestions('#bulkLabels'), ['we'], 'a new label to make')
  await press('b', Key.ENTER)
  assert.deepEqual(await js("return [...document.querySelectorAll('#bulkLabels .Chip')].map((chip) => chip.dataset.label)"), ['web'])
  await press(Key.ENTER) // an empty field: the dialog's Add
  await until('the chip in Work', async () => (await tileLabels())[0]?.join() === 'web,Work')
  await click('#undo')
  await until('the chip gone', async () => (await tileLabels())[0]?.join() === 'Work')
  await click('#redo')
  await until('the chip back', async () => (await tileLabels())[0]?.join() === 'web,Work')
})

test('removing a label the sparks lack changes nothing, and labels say nothing', async () => {
  await click('#labelBulk')
  await until('Labels', async () => (await openDialogs()).join() === 'Labels')
  await driver.findElement(By.css('#bulkLabels input')).sendKeys('Trip to Rome')
  assert.ok(await js("return document.querySelector('#bulkLabels .Suggest').checkVisibility()"), 'the list open')
  await driver.findElement(By.css('#labelModal [value=remove]')).click() // a real click: the list closing mustn't move the button away
  await until('the dialog to close', async () => (await openDialogs()).length === 0)
  assert.equal((await tileLabels())[0]?.join(), 'web,Work')
  assert.ok(await noNotification(), 'the chips show it')
  await press(Key.ESCAPE) // the selection; the next Esc would leave Edit
})

test("a view's filter shows sparks by their labels, the grid follows while editing, Cancel takes it back", async () => {
  await addView('Homeoffice')
  assert.equal(await sparkCount(), 0)
  await contextMenu('#main', 'Edit view')
  await until('the filter', async () => (await openDialogs()).join() === 'Edit')
  await driver.findElement(By.css('#ruleInclude input')).click()
  assert.deepEqual(await suggested('#ruleInclude'), ['Trip to Rome 1', 'web 2', 'Work 1'], 'each label but its own, with its count')
  await pick('#ruleInclude', 'web')
  await until('the live grid', async () => (await sparkTitles()).join() === 'beta.example,gamma.example')
  await driver.findElement(By.css('#ruleExclude input')).click()
  assert.deepEqual(await suggested('#ruleExclude'), ['Trip to Rome 1', 'Work 1'], 'not what it includes')
  await pick('#ruleExclude', 'Work')
  await until('without Work', async () => (await sparkTitles()).join() === 'beta.example')
  await click('#ruleAll [data-value="on"]')
  assert.equal(await js("return document.querySelector('#ruleIncludeHead').textContent"), 'Require', 'from all sparks, the labels narrow')
  await pick('#ruleInclude', 'Trip to Rome')
  await until('with both: none', async () => (await sparkCount()) === 0)
  await click('#ruleAll [data-value="off"]')
  await until('with either', async () => (await sparkTitles()).join() === 'alpha.example,beta.example')
  await click('#ruleInclude [data-remove="Trip to Rome"]')
  await until('web alone', async () => (await sparkTitles()).join() === 'beta.example')
  await js("document.querySelector('#ruleModal [data-close]').click()")
  await until('the grid back', async () => (await sparkCount()) === 0)
  await contextMenu(await row('Homeoffice'), 'Edit')
  await until('the filter', async () => (await openDialogs()).join() === 'Edit')
  assert.deepEqual(await js("return [...document.querySelectorAll('#ruleModal .Chip')].length"), 0, 'Cancel kept nothing')
  await pick('#ruleInclude', 'web')
  await pick('#ruleExclude', 'Work')
  await click('#ruleModal .Button--primary')
  await until('the saved filter', async () => (await sparkTitles()).join() === 'beta.example')
  const views = await stored<{ title: string; rule: { include: string[]; exclude: string[] } }[]>('views')
  const homeoffice = views.find((view) => view.title === 'Homeoffice')
  assert.deepEqual([homeoffice?.rule.include, homeoffice?.rule.exclude], [['web'], ['Work']])
  await showView('Unlabeled')
  assert.deepEqual(await sparkTitles(), [], 'every spark has a label now')
})

test('a view sorts by name, and a drag there switches it to its own order from what was shown', async () => {
  await showView('All')
  await click('#viewSort .Dropdown__button')
  await js("[...document.querySelectorAll('#viewSort .Dropdown__option')].find((option) => option.textContent === 'Name').click()")
  await until('by name', async () => (await sparkTitles()).join() === 'alpha.example,beta.example,gamma.example')
  await click('#viewSort .Dropdown__button')
  await js("[...document.querySelectorAll('#viewSort .Dropdown__option')].find((option) => option.textContent === 'Date added').click()")
  await until('newest first', async () => (await sparkTitles()).join() === 'gamma.example,beta.example,alpha.example')
  await js(`
    const dataTransfer = new DataTransfer()
    const tiles = document.querySelectorAll('#sparks .Spark[data-id]')
    const [moving, target] = [tiles[2], tiles[0]]
    moving.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
    const box = target.getBoundingClientRect()
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: box.left + 2, clientY: box.top + 2 }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: box.left + 2, clientY: box.top + 2 }))
    moving.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))`)
  await until('its own order', async () => (await sparkTitles()).join() === 'alpha.example,gamma.example,beta.example')
  assert.equal(await js("return document.querySelector('#viewSort .Dropdown__button').textContent"), 'Custom')
})

test('Remove from a view takes its label, and says what its filter still shows', async () => {
  await showView('Work')
  await clearNotifications()
  await js("document.querySelector('#sparks .Spark[data-id]').click()")
  assert.equal(await js("return document.querySelector('#removeFromView').textContent"), 'Remove from Work')
  await click('#removeFromView')

  await until('Work empty', async () => (await sparkCount()) === 0)
  assert.ok(await noNotification(), 'the grid shows it')
  await click('#undo')
  await until('back in Work', async () => (await sparkCount()) === 1)
  await contextMenu(await row('Work'), 'Edit')
  await until('the filter', async () => (await openDialogs()).join() === 'Edit')
  await pick('#ruleInclude', 'web')
  await click('#ruleModal .Button--primary')
  await until('web in Work, by name', async () => (await sparkTitles()).join() === 'beta.example,gamma.example')
  await js("[...document.querySelectorAll('#sparks .Spark[data-id]')].find((tile) => tile.querySelector('.Title').textContent === 'gamma.example').click()")
  await click('#removeFromView')
  assert.equal(await notification(), '1 spark still shown: the filter picks them', 'out of sight: only its label went')
  assert.equal(await sparkCount(), 2)
  await click('#undo')
  await click('#undo')
  await until('Work as before', async () => (await sparkTitles()).join() === 'gamma.example')
})

test('chips hide, and take grey, the accent or their own color', async () => {
  await showView('All')
  const chip = '#sparks .Chip'
  const background = (): Promise<string> => js('return getComputedStyle(document.querySelector(arguments[0])).backgroundColor', chip)
  await click('[data-setting="labelColor"] [data-value="monochrome"]')
  await until('grey', async () => (await js('return document.documentElement.dataset.labelColor')) === 'monochrome')
  const grey = await background()
  await click('[data-setting="labelColor"] [data-value="solid"]')
  await until('the accent', async () => (await background()) === 'rgb(194, 65, 12)')
  await click('[data-setting="labelColor"] [data-value="colorful"]')
  await until('its own color', async () => ![grey, 'rgb(194, 65, 12)'].includes(await background()))
  await click('[data-setting="labels"] [data-value="off"]')
  await until('no chips', () => js('return !document.querySelector(arguments[0]).checkVisibility()', chip))
  await click('[data-setting="labels"] [data-value="on"]')
  await until('the chips back', () => js('return document.querySelector(arguments[0]).checkVisibility()', chip))
  await click('[data-setting="titles"] [data-value="off"]')
  await until('no titles', () => js("return !document.querySelector('#sparks .Spark[data-id] .Title').checkVisibility()"))
  assert.ok(await js('return document.querySelector(arguments[0]).checkVisibility()', chip), 'the chips stay without titles')
  await click('[data-setting="titles"] [data-value="on"]')
})

test('a click on a chip opens the view of that name, or shows its sparks in the search', async () => {
  await edit()
  assert.equal(await js("return getComputedStyle(document.querySelector('#viewSort')).visibility"), 'hidden', 'the sort is for Edit')
  await showView('All')
  await js("[...document.querySelectorAll('#sparks .Chip')].find((chip) => chip.dataset.label === 'Work').click()")
  await until('Work', async () => (await js<string>("return document.querySelector('.Group--active .Name').textContent")) === 'Work')
  await js("[...document.querySelectorAll('#sparks .Chip')].find((chip) => chip.dataset.label === 'web').click()")
  await until("the sparks with web, in All's order", async () => (await sparkTitles()).join() === 'gamma.example,beta.example')
  assert.equal(await js("return document.querySelector('#search').value"), 'web')
  await press(Key.ESCAPE)
  await edit()
})

test('the search finds sparks by their labels, and a label picked shows exactly its sparks', async () => {
  await driver.findElement(By.css('#search')).click()
  await press('rome')
  await until('the spark with Trip to Rome', async () => (await sparkTitles()).join() === 'alpha.example')
  await press(Key.BACK_SPACE, Key.BACK_SPACE, Key.BACK_SPACE, Key.BACK_SPACE, 'we')
  await until('the label first', () =>
    js(
      "const item = document.querySelector('#suggest .SuggestItem'); return item?.dataset.label === 'web' && item.querySelector('small').textContent === '2 sparks'"
    )
  )
  await press(Key.ENTER)
  await until('the sparks with web', async () => (await sparkTitles()).join() === 'gamma.example,beta.example')
  await press(Key.ESCAPE)
  await until('the search cleared', () => js("return document.querySelector('#search').value === ''"))
  await showView('All')
})

test('All and Unlabeled can be hidden from the sidebar', async () => {
  await click('[data-setting="builtIn"] [data-value="off"]')
  await until('only the own views', async () => (await viewNames()).join() === 'Work,Homeoffice')
  assert.equal(await js<string>("return document.querySelector('.Group--active .Name').textContent"), 'Work', 'the first one listed instead')
  await click('[data-setting="builtIn"] [data-value="on"]')
  await until('All back', async () => (await viewNames())[0] === 'All')
  await showView('All')
})

test('deleting a view asks, and the view only leaves its sparks and their label', async () => {
  const before = await viewNames()
  await contextMenu(await row('Homeoffice'), 'Delete')
  await until('the question', async () => (await openDialogs()).join() === 'Delete Homeoffice')
  assert.equal(await js("return document.querySelector('#deleteViewText').textContent"), 'Delete Homeoffice?', 'none of its own: nothing to choose')
  await click('#deleteViewModal [value="view"]')
  await until('the view to go', async () => (await viewNames()).length === before.length - 1)
  await showView('All')
  assert.equal(await sparkCount(), 3)
  await contextMenu(await row('Work'), 'Delete')
  await until('the question', async () => (await openDialogs()).join() === 'Delete Work')
  assert.equal(await js("return document.querySelector('#deleteViewText').textContent"), 'Delete Work only, or with its spark?')
  await click('#deleteViewModal [value="sparks"]')
  await until('Work and its spark to go', async () => (await sparkCount()) === 2 && !(await viewNames()).includes('Work'))
  await click('#undo')
  await until('back', async () => (await sparkCount()) === 3 && (await viewNames()).includes('Work'))
})

test('a spark dragged out of FireDial carries its address and title, not its chips', async () => {
  await showView('All')
  const data = await js<string[]>(`
    const dataTransfer = new DataTransfer()
    const tile = document.querySelector('#sparks .Spark[data-id]')
    tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
    tile.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
    return ['text/x-moz-url', 'text/uri-list', 'text/plain'].map((type) => dataTransfer.getData(type))`)
  assert.deepEqual(data, ['https://alpha.example/\nalpha.example', 'https://alpha.example/', 'https://alpha.example/'])
  await edit()
})
