// FireDial new tab page.

import { backupName, exportParts, importSummary, readBackup } from './backup.ts'
import { honeycomb, mainColor, markOn, textOn } from './color.ts'
import { saveFile } from './download.ts'
import {
  accentOf,
  allocGroup,
  allocSpark,
  clamp,
  DEFAULT_PREFS,
  GroupId,
  isColor,
  isGroupId,
  isLayout,
  isSparkId,
  isTheme,
  isVanilla,
  LimitError,
  LIMITS,
  MAX_COLUMNS,
  MAX_GROUP_WIDTH,
  MIN_COLUMNS,
  MIN_GROUP_WIDTH,
  newThumbId,
  normalizeUrl,
  plural,
  searchUrl,
  toHexColor,
  toLabel,
  toSparkUrl
} from './model.ts'
import type { Group, Label, Prefs, Spark, SparkId, ThumbId } from './model.ts'
import { browserKeyValue, Store, webLock } from './store.ts'
import { THEME_KEY } from './theme-key.ts'
import type { CommitOptions, ImportedData, Mutate } from './store.ts'
import { sameItems, SelectionTrail } from './trail.ts'
import { clearable } from './ui/clearable.ts'
import { Confirm } from './ui/confirm.ts'
import type { Question } from './ui/confirm.ts'
import { $, $$, closest, el, html, icon, targetOf } from './ui/dom.ts'
import { Dropdown } from './ui/dropdown.ts'
import type { Choice } from './ui/dropdown.ts'
import { editable } from './ui/editable.ts'
import { Modal } from './ui/modal.ts'
import { showToast, toastArgs } from './ui/toast.ts'

const THUMB_MAX_WIDTH = 640
const SMALL_IMAGE = 128 // px wide: an icon rather than a screenshot
const COLOR_SAMPLE = 32 // px: the size an image is read at for its main color
const COLOR_SAVE_DELAY = 1000 // ms
const MAIN_PADDING = 48 // px, both sides, as in newtab.css
const DENSITIES: readonly (readonly [string, number])[] = [
  ['Tight', 6],
  ['Compact', 12],
  ['Cozy', 18],
  ['Roomy', 26],
  ['Airy', 36]
]
const RESIZE_STEP = 10 // px per arrow key, five times that with Shift
const MAX_HITS = 5
const darkScheme = matchMedia('(prefers-color-scheme: dark)')
const narrow = matchMedia('(max-width: 700px)') // read-only view; the same width as in newtab.css

const store = new Store(browserKeyValue, webLock)
const thumbs = new Map<ThumbId, string>() // images never change, so this never goes stale
const colors = new Map<ThumbId, string>()
const selection = new Set<SparkId>()
const markedGroups = new Set<GroupId>()

interface Marks {
  sparks: SparkId[]
  groups: GroupId[]
}

const selectionTrail = new SelectionTrail<Marks>((a, b) => sameItems(a.sparks, b.sparks) && sameItems(a.groups, b.groups))

type Drag = { type: 'spark'; ids: Set<SparkId> } | { type: 'group'; id: GroupId }

let active = GroupId.parse(0)
let query = ''
let editing = false
let drag: Drag | null = null
let lastSelected = -1
let renderToken = 0
let stale = false
let revealing: SparkId | null = null

// Helpers

const sparkIdOf = (node: HTMLElement): SparkId | null => {
  const id = Number(node.dataset['id'] ?? NaN)
  return isSparkId(id) ? id : null
}

const groupIdOf = (node: HTMLElement): GroupId | null => {
  const id = Number(node.dataset['id'] ?? NaN)
  return isGroupId(id) ? id : null
}

const sparkById = (id: SparkId | null): Spark | undefined => store.doc.sparks.find((spark) => spark.id === id)
const groupById = (id: GroupId | null): Group | undefined => store.doc.groups.find((group) => group.id === id)
const isTyping = (): boolean => document.activeElement?.matches('input:not([type=range]), textarea') ?? false
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const firstGroupId = (): GroupId => store.doc.groups[0]?.id ?? active

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function titleFromUrl(url: string): string {
  return hostOf(url) || url.split(/[/\\]/).filter(Boolean).pop() || url
}

function letterOf(preview: { title: string; url: string }): string {
  const host = preview.url.replace(/^[a-z]+:\/+(www\.)?/i, '')
  return (preview.title.trim() || host).charAt(0)
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '')
    }
    reader.onerror = () => {
      reject(new Error(reader.error?.message ?? 'Read failed'))
    }
    reader.readAsDataURL(file)
  })
}

// Large screenshots are scaled down so storage and new tabs stay fast.
async function shrinkImage(src: string): Promise<string> {
  const img = new Image()
  try {
    // onload rather than decode(): decode() never settles while the page is in the background.
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = src
    })
  } catch {
    return src
  }
  if (img.naturalWidth <= THUMB_MAX_WIDTH) return src
  const canvas = el('canvas', { width: THUMB_MAX_WIDTH, height: Math.round((img.naturalHeight * THUMB_MAX_WIDTH) / img.naturalWidth) })
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/webp', 0.85)
}

const notify = (text: string): void => {
  showToast(...toastArgs(text, store.doc.prefs))
}

// Opening sparks

// Firefox doesn't let extensions open file: and about: URLs, so those sparks copy their URL.
const isBlocked = (url: string): boolean => /^(file|about):/i.test(url)

async function copyBlocked(url: string): Promise<void> {
  await navigator.clipboard.writeText(url)
  notify('URL copied: paste it in the address bar')
}

function openTab(url: string): void {
  if (isBlocked(url)) void copyBlocked(url)
  else void browser.tabs.create({ url, active: false })
}

function openUrl(url: string, newTab: boolean): void {
  if (newTab) openTab(url)
  else if (isBlocked(url)) void copyBlocked(url)
  else location.href = url
}

// Changes: every change goes through the store, so all of them are undoable and reach all tabs.

async function change(mutate: Mutate, options: Omit<CommitOptions, 'active'> = {}): Promise<void> {
  try {
    await store.commit(
      (doc) => {
        const shown = mutate(doc)
        if (shown !== undefined) active = shown
        return shown
      },
      { ...options, active }
    )
  } catch (error) {
    if (!(error instanceof LimitError)) throw error
    notify(error.message)
  }
  await afterChange()
}

async function afterChange(): Promise<void> {
  selectionTrail.clear()
  if (!groupById(active)) active = firstGroupId()
  const known = new Set(store.doc.sparks.map((spark) => spark.id))
  for (const id of selection) {
    if (!known.has(id)) selection.delete(id)
  }
  for (const id of markedGroups) {
    if (!groupById(id)) markedGroups.delete(id)
  }
  void browserKeyValue.set({ activeGroup: active })
  await render()
}

async function travel(step: Promise<GroupId | null>): Promise<void> {
  const shown = await step
  if (shown !== null && groupById(shown)) active = shown
  await afterChange()
}

function undo(): Promise<void> {
  const step = selectionTrail.undo(marks())
  if (!step) return travel(store.undo())
  setSelection(step.sparks, step.groups)
  return Promise.resolve()
}

function redo(): Promise<void> {
  const step = selectionTrail.redo(marks())
  if (!step) return travel(store.redo())
  setSelection(step.sparks, step.groups)
  return Promise.resolve()
}

async function loadThumbs(sparks: readonly Spark[]): Promise<void> {
  const missing = sparks
    .map((spark) => spark.thumb)
    .filter((thumb) => thumb !== null)
    .filter((thumb) => !thumbs.has(thumb))
  for (const [id, src] of await store.thumbs(missing)) thumbs.set(id, src)
}

const thumbOf = (spark: Spark): string => (spark.thumb ? (thumbs.get(spark.thumb) ?? '') : '')

// Rendering

function render(): Promise<void> {
  applyPrefs()
  renderGroups()
  renderSelection()
  return renderSparks()
}

function settingValue(prefs: Prefs, name: string | undefined): string {
  if (name === 'titles') return prefs.showTitle ? 'on' : 'off'
  if (name === 'counts') return prefs.showCounts ? 'on' : 'off'
  if (name === 'theme') return prefs.theme
  if (name === 'color') return prefs.color
  return prefs.layout
}

// Fills are the color itself. What's written on them and what's drawn on the page follow from it.
function applyAccent(accent: string): void {
  const root = document.documentElement
  const page = getComputedStyle(root)
  const onAccent = textOn(accent)
  root.style.setProperty('--on-accent', onAccent)
  root.style.setProperty('--off-accent', textOn(onAccent))
  root.style.setProperty('--accent-mark', markOn(accent, [page.getPropertyValue('--surface'), page.getPropertyValue('--bg')], 'var(--text)'))
}

// The page's first paint happens before the store is read: theme.ts paints it in the last theme
// shown, so a dark FireDial doesn't flash light. Only the colors, never data.
function rememberTheme(theme: string): void {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // no localStorage: the first paint is light
  }
}

function applyPrefs(): void {
  const root = document.documentElement
  const { prefs } = store.doc
  root.dataset['theme'] = prefs.theme === 'system' ? (darkScheme.matches ? 'dark' : 'light') : prefs.theme
  rememberTheme(root.dataset['theme'])
  root.dataset['color'] = prefs.color
  root.style.setProperty('--custom', prefs.customColor)
  applyAccent(accentOf(prefs))
  root.dataset['titles'] = prefs.showTitle ? 'on' : 'off'
  root.dataset['counts'] = prefs.showCounts ? 'on' : 'off'
  root.dataset['layout'] = prefs.layout
  applyDensity(prefs.density)
  applyGroupWidth(prefs.groupWidth)
  applyColumns(prefs.columns)
  html('#customValue').textContent = prefs.customColor.toUpperCase()
  if (document.activeElement !== customInput) customInput.value = prefs.customColor.toUpperCase()
  for (const cell of $$('.Hex', HTMLElement)) cell.setAttribute('aria-pressed', String(prefs.color === 'custom' && cell.dataset['hex'] === prefs.customColor))
  html('#app').classList.toggle('App--options', editing)
  html('#options').hidden = !editing
  html('#history').hidden = !editing
  html('#trash').hidden = !editing
  for (const button of $$('[data-setting] > button', HTMLButtonElement)) {
    button.setAttribute('aria-pressed', String(settingValue(prefs, button.parentElement?.dataset['setting']) === button.dataset['value']))
  }
}

// The most columns the current layout and spacing fit, without the options next to the grid.
function columnLimit(): number {
  const style = getComputedStyle(grid)
  const gap = Number.parseFloat(style.columnGap) || 0
  const tile = Number.parseFloat(style.getPropertyValue('--tile-min'))
  const width = innerWidth - html('.Rail').offsetWidth - MAIN_PADDING - (main.offsetWidth - main.clientWidth)
  return clamp(Math.floor((width + gap) / (tile + gap)), MIN_COLUMNS, MAX_COLUMNS)
}

// The saved count stays as it is: it comes back with a layout or window that fits it.
function applyColumns(columns: number): void {
  const limit = columnLimit()
  const shown = Math.min(columns, limit)
  const { style } = document.documentElement
  style.setProperty('--columns', String(columns))
  style.setProperty('--columns-shown', String(shown))
  columnsInput.max = String(limit)
  columnsInput.value = String(shown)
  columnsOut.value = String(shown)
}

function applyDensity(density: number): void {
  const [name, gap] = DENSITIES[clamp(density, 1, DENSITIES.length) - 1] ?? ['', 0]
  document.documentElement.style.setProperty('--gap', `${gap}px`)
  densityInput.value = String(density)
  densityOut.value = name
}

let groupWidth = DEFAULT_PREFS.groupWidth // px, as shown: ahead of the prefs while dragging

function applyGroupWidth(width: number): void {
  groupWidth = clamp(Math.round(width), MIN_GROUP_WIDTH, MAX_GROUP_WIDTH)
  document.documentElement.style.setProperty('--rail', `${groupWidth}px`)
  railResize.setAttribute('aria-valuenow', String(groupWidth))
}

function renderHistory(): void {
  $('#undo', HTMLButtonElement).disabled = !store.canUndo && !selectionTrail.canUndo
  $('#redo', HTMLButtonElement).disabled = !store.canRedo && !selectionTrail.canRedo
}

function renderGroups(): void {
  const counts = new Map<GroupId, number>()
  for (const { groupId } of store.doc.sparks) counts.set(groupId, (counts.get(groupId) ?? 0) + 1)
  groupsNav.replaceChildren(...store.doc.groups.map((group) => groupItem(group, counts.get(group.id) ?? 0)))
  groupPick.setChoices(groupChoices(), active)
}

// The last one stays: sparks need a place to land.
const canDeleteGroup = (): boolean => store.doc.groups.length > 1
const groupChoices = (): Choice<GroupId>[] => store.doc.groups.map((group) => ({ value: group.id, label: group.title }))

// Not a link, so Firefox's context menu shows no link items for groups.
function groupItem(group: Group, count: number): HTMLElement {
  const isActive = group.id === active && !query
  const input = el('input', { class: 'NameInput', maxlength: LIMITS.label, 'aria-label': 'Group name' })
  input.value = group.title
  editable(
    input,
    () => {
      const title = toLabel(input.value)
      if (title && title !== group.title) void renameGroup(group, title)
      else input.value = group.title
    },
    () => {
      input.value = group.title
    }
  )
  return el(
    'div',
    {
      class: `Group${isActive ? ' Group--active' : ''}${markedGroups.has(group.id) ? ' Group--marked' : ''}`,
      role: 'button',
      tabindex: 0,
      'data-id': group.id
    },
    el('span', { class: 'Handle', draggable: true }, icon('grip')),
    el('span', { class: 'Name' }, group.title),
    input,
    el('small', {}, String(count))
  )
}

function visibleSparks(): Spark[] {
  if (!query) return store.doc.sparks.filter((spark) => spark.groupId === active)
  const needle = query.toLowerCase()
  return store.doc.sparks.filter((spark) => spark.title.toLowerCase().includes(needle) || spark.url.toLowerCase().includes(needle))
}

async function renderSparks(): Promise<void> {
  const token = ++renderToken
  const sparks = visibleSparks()
  await loadThumbs(sparks)
  if (token !== renderToken) return
  grid.replaceChildren(...sparks.map(sparkTile), ...(query || narrow.matches ? [] : [addTile()]))
  alignBars()
}

// The bars and notifications line up with the sparks, scrollbar or not.
function alignBars(): void {
  document.documentElement.style.setProperty('--scrollbar', `${main.offsetWidth - main.clientWidth}px`)
}

let colorSave = 0

function rememberColor(id: ThumbId, color: string): void {
  colors.set(id, color)
  clearTimeout(colorSave)
  colorSave = window.setTimeout(() => void store.saveColors(colors), COLOR_SAVE_DELAY)
}

function readColor(img: HTMLImageElement): string | null {
  const context = el('canvas', { width: COLOR_SAMPLE, height: COLOR_SAMPLE }).getContext('2d', { willReadFrequently: true })
  try {
    context?.drawImage(img, 0, 0, COLOR_SAMPLE, COLOR_SAMPLE)
    const pixels = context?.getImageData(0, 0, COLOR_SAMPLE, COLOR_SAMPLE)
    return pixels ? mainColor(pixels.data, COLOR_SAMPLE, COLOR_SAMPLE) : null
  } catch {
    return null // images from other sites can't be read
  }
}

// thumb: the image's id, null for one that isn't stored yet.
function thumbBox(preview: { title: string; url: string }, src: string, thumb: ThumbId | null): HTMLElement {
  const box = el('div', { class: 'Thumb' })
  const known = thumb ? colors.get(thumb) : undefined
  const letter = (): HTMLElement => el('span', { class: 'Letter' }, letterOf(preview))
  if (!src) {
    box.append(letter())
    return box
  }
  const img = el('img', { src, alt: '', draggable: false, loading: 'lazy' })
  img.addEventListener(
    'error',
    () => {
      img.replaceWith(letter())
    },
    { once: true }
  )
  img.addEventListener(
    'load',
    () => {
      box.classList.toggle('Thumb--small', img.naturalWidth < SMALL_IMAGE)
      if (known !== undefined) return
      const color = readColor(img)
      if (color) box.style.setProperty('--thumb-color', color)
      if (thumb) rememberColor(thumb, color ?? '')
    },
    { once: true }
  )
  if (known) box.style.setProperty('--thumb-color', known)
  box.append(img)
  return box
}

function sparkTile(spark: Spark): HTMLElement {
  const host = hostOf(spark.url)
  return el(
    'a',
    { class: `Spark${selection.has(spark.id) ? ' Spark--selected' : ''}`, href: spark.url, draggable: editing, 'data-id': spark.id },
    thumbBox(spark, thumbOf(spark), spark.thumb),
    el(
      'div',
      { class: 'Text' },
      el('div', { class: 'Title' }, spark.title || host),
      el('div', { class: 'Host' }, host || spark.url),
      query && el('div', { class: 'In' }, `in ${groupById(spark.groupId)?.title ?? ''}`)
    ),
    el('button', { type: 'button', class: 'Strip EditSpark', 'aria-label': 'Edit', tabindex: -1 }, icon('edit'))
  )
}

// A div, not a button: Firefox doesn't let an input inside a button take clicks.
function addTile(): HTMLElement {
  return el(
    'div',
    { class: 'Spark AddSpark Skeleton', role: 'button', tabindex: 0, 'aria-label': 'New spark' },
    el('div', { class: 'Thumb' }),
    el('div', { class: 'Text' }, el('div', { class: 'Title' }, ' ')),
    el('span', { class: 'Plus' }, icon('plus'))
  )
}

function openAddTile(tile: HTMLElement): void {
  if (tile.classList.contains('AddSpark--editing')) return
  tile.classList.add('AddSpark--editing')
  const input = el('input', { placeholder: 'Paste URL', autocomplete: 'off', spellcheck: false, maxlength: LIMITS.url, 'aria-label': 'URL' })
  html('.Plus', tile).replaceWith(input)
  // Later, not at once: a click may be on its way to what's under the mouse.
  const close = (): void => {
    setTimeout(() => void renderSparks(), 100)
  }
  editable(
    input,
    () => {
      if (input.value.trim()) void addSparkFromUrl(input.value)
      else close()
    },
    () => {
      input.value = ''
    }
  )
  input.focus()
}

function addSparkFromUrl(text: string): Promise<void> {
  const url = toSparkUrl(normalizeUrl(text))
  if (!url) {
    notify('Not added: the URL is too long')
    return renderSparks()
  }
  const groupId = active
  return change((doc) => {
    allocSpark(doc, { groupId, title: toLabel(titleFromUrl(url)), url, thumb: null })
    return undefined
  })
}

// Selection and edit mode

const tiles = (): HTMLElement[] => $$('#sparks .Spark[data-id]', HTMLElement)

function renderSelection(): void {
  for (const tile of tiles()) {
    const id = sparkIdOf(tile)
    tile.classList.toggle('Spark--selected', id !== null && selection.has(id))
  }
  for (const row of $$('.Group', HTMLElement)) {
    const id = groupIdOf(row)
    row.classList.toggle('Group--marked', id !== null && markedGroups.has(id))
  }
  renderTrash()
  renderHistory()
}

const marks = (): Marks => ({ sparks: [...selection], groups: [...markedGroups] })
const markCount = (): number => selection.size + markedGroups.size

function renderTrash(): void {
  const count = markCount()
  trash.classList.toggle('Trash--armed', count > 0)
  html('span', trash).textContent = drag ? 'Drop to delete' : count ? `Delete ${count}` : 'Delete'
}

function setSelection(ids: Iterable<SparkId>, groups: Iterable<GroupId> = markedGroups): void {
  const [nextSparks, nextGroups] = [[...ids], [...groups]]
  selection.clear()
  markedGroups.clear()
  nextSparks.forEach((id) => selection.add(id))
  nextGroups.forEach((id) => markedGroups.add(id))
  if (!selection.size) lastSelected = -1
  renderSelection()
}

const clearSelection = (): void => {
  setSelection([], [])
}

// The user's own changes: these can be undone.
function changeSelection(ids: Iterable<SparkId>, groups: Iterable<GroupId> = markedGroups): void {
  const next = { sparks: [...new Set(ids)], groups: [...new Set(groups)] }
  selectionTrail.record(marks(), next)
  setSelection(next.sparks, next.groups)
}

function toggleTile(tile: HTMLElement, range: boolean): void {
  const all = tiles()
  const index = all.indexOf(tile)
  const id = sparkIdOf(tile)
  const ids = new Set(selection)
  if (range && lastSelected >= 0) {
    for (const item of all.slice(Math.min(lastSelected, index), Math.max(lastSelected, index) + 1)) {
      const itemId = sparkIdOf(item)
      if (itemId !== null) ids.add(itemId)
    }
  } else if (id !== null && ids.has(id)) {
    ids.delete(id)
  } else if (id !== null) {
    ids.add(id)
  }
  changeSelection(ids)
  lastSelected = index
}

function setEditing(on: boolean): void {
  editing = on
  document.body.classList.toggle('editing', on)
  const toggle = html('#editToggle')
  toggle.setAttribute('aria-pressed', String(on))
  html('span', toggle).textContent = on ? 'Done' : 'Edit'
  if (!on) {
    selectionTrail.clear()
    clearSelection()
  }
  applyPrefs()
  renderGroups()
  void renderSparks()
}

// Changes to sparks and groups

// All deleting ends here: what's marked, or the one item from a menu or the trash.
async function deleteItems(sparks: ReadonlySet<SparkId>, groups: ReadonlySet<GroupId>): Promise<boolean> {
  if (groups.size >= store.doc.groups.length) {
    notify('One group has to stay')
    return false
  }
  await change((doc) => {
    doc.sparks = doc.sparks.filter((spark) => !sparks.has(spark.id) && !groups.has(spark.groupId))
    doc.groups = doc.groups.filter((group) => !groups.has(group.id))
    return undefined
  })
  return true
}

const deleteSpark = (spark: Spark): Promise<boolean> => deleteItems(new Set([spark.id]), new Set())
const deleteGroup = (group: Group): Promise<boolean> => deleteItems(new Set(), new Set([group.id]))

async function deleteMarked(): Promise<void> {
  if (markCount() && (await deleteItems(new Set(selection), new Set(markedGroups)))) clearSelection()
}

async function moveSparks(ids: ReadonlySet<SparkId>, groupId: GroupId): Promise<void> {
  const count = store.doc.sparks.filter((spark) => ids.has(spark.id) && spark.groupId !== groupId).length
  await change((doc) => {
    const moving = doc.sparks.filter((spark) => ids.has(spark.id) && spark.groupId !== groupId)
    const moved = new Set(moving.map((spark) => spark.id))
    doc.sparks = [...doc.sparks.filter((spark) => !moved.has(spark.id)), ...moving.map((spark) => ({ ...spark, groupId }))]
    return undefined
  })
  if (count) notify(`Moved ${plural(count, 'spark')} to ${groupById(groupId)?.title ?? ''}`)
}

// Puts the sparks before or after the target spark; without a target, after the active group's last.
function reorderSparks(ids: ReadonlySet<SparkId>, targetId: SparkId | null, after: boolean): Promise<void> {
  const groupId = active
  return change((doc) => {
    const moving = doc.sparks.filter((spark) => ids.has(spark.id))
    const rest = doc.sparks.filter((spark) => !ids.has(spark.id))
    const index =
      targetId === null
        ? rest.findLastIndex((spark) => spark.groupId === groupId) + 1 || rest.length
        : rest.findIndex((spark) => spark.id === targetId) + (after ? 1 : 0)
    const targetGroup = targetId === null ? groupId : (rest.find((spark) => spark.id === targetId)?.groupId ?? groupId)
    rest.splice(index, 0, ...moving.map((spark) => ({ ...spark, groupId: targetGroup })))
    doc.sparks = rest
    return undefined
  })
}

function createGroup(title: Label): Promise<void> {
  return change((doc) => allocGroup(doc, title).id)
}

function renameGroup(group: Group, title: Label): Promise<void> {
  return change((doc) => {
    const target = doc.groups.find((item) => item.id === group.id)
    if (target) target.title = title
    return undefined
  })
}

function reorderGroup(id: GroupId, targetId: GroupId, after: boolean): Promise<void> {
  if (id === targetId) return Promise.resolve()
  return change((doc) => {
    const moving = doc.groups.find((group) => group.id === id)
    if (!moving) return undefined
    const rest = doc.groups.filter((group) => group.id !== id)
    rest.splice(rest.findIndex((group) => group.id === targetId) + (after ? 1 : 0), 0, moving)
    doc.groups = rest
    return undefined
  })
}

function setActive(id: GroupId): void {
  lastSelected = -1
  active = id
  void browserKeyValue.set({ activeGroup: id })
  clearSearch(false)
  void render()
}

// Groups in the rail: rename inline (edit mode), new group

function focusGroupName(id: GroupId): void {
  const input = document.querySelector(`.Group[data-id="${id}"] .NameInput`)
  if (!(input instanceof HTMLInputElement)) return
  input.focus()
  input.select()
}

const groupsNav = html('#groups')
const grid = html('#sparks')

const groupPick = new Dropdown<GroupId>(html('#groupPick'), 'Group', setActive)

function startNewGroup(): void {
  const button = html('#newGroup')
  if (!button.isConnected) return
  const input = el('input', { class: 'NewGroupInput', placeholder: 'Name group', maxlength: LIMITS.label, 'aria-label': 'Name group' })
  button.replaceWith(input)
  input.focus()
  editable(
    input,
    () => {
      input.replaceWith(button)
      const title = toLabel(input.value)
      if (!title) return
      clearSearch(false)
      void createGroup(title)
    },
    () => {
      input.value = ''
    }
  )
}

// Search: filters sparks by title and URL; suggestions are the matching sparks plus a web
// search. "@keyword " or an engine's alias picks the search engine.

interface Engine {
  name: string
  isDefault: boolean
  alias?: string | undefined
}

interface ParsedQuery {
  engine: Engine | undefined
  terms: string
  explicit: boolean
}

const searchInput = $('#search', HTMLInputElement)
const suggestBox = html('#suggest')
const refreshSearchClear = clearable(searchInput)
let engines: Engine[] = []
let suggestIndex = 0

async function loadEngines(): Promise<void> {
  try {
    engines = await browser.search.get()
  } catch (error) {
    console.error('search.get:', error)
    engines = []
  }
}

const engineKeywords = (engine: Engine): string[] =>
  [engine.alias, `@${engine.name.split(/\s+/)[0] ?? ''}`].filter((keyword) => keyword !== undefined).map((keyword) => keyword.toLowerCase())

function parseQuery(text: string): ParsedQuery {
  const match = /^(\S+)\s+(.*)$/s.exec(text)
  const keyword = match?.[1]?.toLowerCase() ?? ''
  const engine = keyword ? engines.find((item) => engineKeywords(item).includes(keyword)) : undefined
  if (engine) return { engine, terms: (match?.[2] ?? '').trim(), explicit: true }
  return { engine: engines.find((item) => item.isDefault) ?? engines[0], terms: text, explicit: false }
}

function webSearch({ engine, terms }: ParsedQuery): void {
  if (!terms) return
  void browser.search.search({ query: terms, ...(engine ? { engine: engine.name } : {}), disposition: 'CURRENT_TAB' })
}

const suggestItems = (): HTMLElement[] => $$('.SuggestItem', HTMLElement, suggestBox)

function renderSuggest(): void {
  if (!query || document.activeElement !== searchInput) {
    suggestBox.hidden = true
    return
  }
  const parsed = parseQuery(query)
  const hits = parsed.explicit ? [] : visibleSparks().slice(0, MAX_HITS)
  const url = searchUrl(query)
  const items = !url
    ? []
    : [
        el(
          'div',
          { class: 'SuggestItem', role: 'option', 'data-url': url },
          icon(isBlocked(url) ? 'copy' : 'open'),
          el('span', {}, `${isBlocked(url) ? 'Copy' : 'Go to'} ${url}`),
          el('kbd', {}, 'Enter')
        )
      ]
  items.push(
    ...hits.map((spark) => {
      const host = hostOf(spark.url)
      const title = spark.title || host
      return el(
        'div',
        { class: 'SuggestItem', role: 'option', 'data-id': spark.id },
        icon('flame'),
        el('span', {}, title),
        host !== title && el('small', {}, host),
        el('kbd', {}, 'Enter')
      )
    })
  )
  items.push(
    el(
      'div',
      { class: 'SuggestItem', role: 'option' },
      icon('globe'),
      el('span', {}, parsed.engine?.name ? `${parsed.engine.name}: ${parsed.terms}` : parsed.terms),
      el('kbd', {}, 'Enter')
    )
  )
  suggestBox.replaceChildren(...items)
  suggestBox.hidden = false
  highlight(0)
}

function highlight(index: number): void {
  const items = suggestItems()
  suggestIndex = (index + items.length) % items.length
  items.forEach((item, i) => {
    item.classList.toggle('SuggestItem--active', i === suggestIndex)
  })
}

function runSuggestion(item: HTMLElement | null | undefined, newTab: boolean): void {
  if (!item) return
  const { id, url } = item.dataset
  if (url) {
    openUrl(url, newTab)
  } else if (id) {
    const spark = sparkById(sparkIdOf(item))
    if (spark) openUrl(spark.url, newTab)
  } else {
    webSearch(parseQuery(query))
  }
}

function clearSearch(rerender = true): void {
  searchInput.value = ''
  refreshSearchClear()
  suggestBox.hidden = true
  if (!query) return
  query = ''
  if (rerender) void render()
}

const focusFirstSpark = (): void => {
  $$('#sparks .Spark', HTMLElement)[0]?.focus()
}

searchInput.addEventListener('input', () => {
  query = searchInput.value.trim()
  renderGroups()
  void renderSparks()
  renderSuggest()
})

searchInput.addEventListener('keydown', (event) => {
  event.stopPropagation()
  const open = !suggestBox.hidden
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (!open || suggestIndex === suggestItems().length - 1) {
      suggestBox.hidden = true
      focusFirstSpark()
    } else highlight(suggestIndex + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (open) highlight(suggestIndex - 1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (open) runSuggestion(suggestItems()[suggestIndex], event.altKey || event.ctrlKey || event.metaKey)
    else focusFirstSpark()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    if (searchInput.value) clearSearch()
    else searchInput.blur()
  }
})

searchInput.addEventListener('focus', renderSuggest)
searchInput.addEventListener('blur', () => {
  setTimeout(() => {
    suggestBox.hidden = document.activeElement !== searchInput || suggestBox.hidden
  }, 150)
})

// mousedown keeps the focus in the field; click runs it (search.search() needs a user action).
suggestBox.addEventListener('mousedown', (event) => {
  event.preventDefault()
})
suggestBox.addEventListener('mousemove', (event) => {
  const item = closest(event, '.SuggestItem')
  if (item) highlight(suggestItems().indexOf(item))
})
suggestBox.addEventListener('click', (event) => {
  runSuggestion(closest(event, '.SuggestItem'), event.ctrlKey || event.metaKey)
})

// Options: applied immediately, saved to prefs, undoable

function applySetting(prefs: Prefs, name: string, value: string): void {
  if (name === 'titles') prefs.showTitle = value === 'on'
  else if (name === 'counts') prefs.showCounts = value === 'on'
  else if (name === 'theme' && isTheme(value)) prefs.theme = value
  else if (name === 'color' && isColor(value)) prefs.color = value
  else if (name === 'layout' && isLayout(value)) prefs.layout = value
}

function changePrefs(edit: (prefs: Prefs) => void): Promise<void> {
  return change((doc) => {
    edit(doc.prefs)
    return undefined
  })
}

const columnsInput = $('#columns', HTMLInputElement)
const columnsOut = $('#columnsOut', HTMLOutputElement)
const densityInput = $('#density', HTMLInputElement)
const densityOut = $('#densityOut', HTMLOutputElement)

columnsInput.addEventListener('input', () => {
  applyColumns(Number(columnsInput.value))
})
columnsInput.addEventListener('change', () => {
  const columns = clamp(Number(columnsInput.value), MIN_COLUMNS, MAX_COLUMNS)
  void changePrefs((prefs) => {
    prefs.columns = columns
  })
})
densityInput.addEventListener('input', () => {
  applyDensity(Number(densityInput.value))
  applyColumns(store.doc.prefs.columns)
})
densityInput.addEventListener('change', () => {
  const density = Number(densityInput.value)
  void changePrefs((prefs) => {
    prefs.density = density
  })
})

// In Edit, the group sidebar's right edge is dragged to resize it, or moved with the arrow keys.
const railResize = html('#railResize')
let resizeFrom: { x: number; width: number } | null = null

function resizeRail(width: number): void {
  applyGroupWidth(width)
  applyColumns(store.doc.prefs.columns)
}

function saveGroupWidth(): void {
  const width = groupWidth
  if (width === store.doc.prefs.groupWidth) return
  void changePrefs((prefs) => {
    prefs.groupWidth = width
  })
}

railResize.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  event.preventDefault()
  railResize.setPointerCapture(event.pointerId)
  resizeFrom = { x: event.clientX, width: groupWidth }
  document.body.classList.add('resizing')
})
railResize.addEventListener('pointermove', (event) => {
  if (resizeFrom) resizeRail(resizeFrom.width + event.clientX - resizeFrom.x)
})
railResize.addEventListener('lostpointercapture', () => {
  resizeFrom = null
  document.body.classList.remove('resizing')
  saveGroupWidth()
})
railResize.addEventListener('dblclick', () => {
  resizeRail(DEFAULT_PREFS.groupWidth)
  saveGroupWidth()
})
railResize.addEventListener('keydown', (event) => {
  const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
  if (!direction) return
  event.preventDefault()
  event.stopPropagation() // not the page's arrow keys, which move between sparks
  resizeRail(groupWidth + direction * RESIZE_STEP * (event.shiftKey ? 5 : 1))
  saveGroupWidth()
})

darkScheme.addEventListener('change', applyPrefs)
window.addEventListener('resize', () => {
  applyColumns(store.doc.prefs.columns)
  alignBars()
})

// The custom color: a cell of the honeycomb, or a typed value.

const honeycombPanel = html('#honeycomb')
const customInput = $('#customColor', HTMLInputElement)

html('#honeycombCells').append(
  ...honeycomb().map((row) =>
    el(
      'div',
      { class: 'Honeycomb__row' },
      ...row.map((hex) => {
        const cell = el('button', { type: 'button', class: 'Hex', 'data-hex': hex, 'aria-label': hex }, el('i'))
        cell.style.setProperty('--hex', hex)
        return cell
      })
    )
  )
)

function setCustomColor(hex: string): void {
  void changePrefs((prefs) => {
    prefs.color = 'custom'
    prefs.customColor = hex
  })
}

customInput.addEventListener('change', () => {
  const hex = toHexColor(customInput.value)
  if (hex) setCustomColor(hex)
  else customInput.value = store.doc.prefs.customColor.toUpperCase()
})

customInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') customInput.blur()
})

function applyNarrow(): void {
  searchInput.placeholder = narrow.matches ? 'Search' : 'Search or enter address'
  groupPick.close()
  if (narrow.matches && editing) setEditing(false)
  else void renderSparks()
}

narrow.addEventListener('change', applyNarrow)

// Export and import

const importModal = new Modal($('#importModal', HTMLDialogElement), 'Importing', false)
const importProgress = $('#importProgress', HTMLProgressElement)
const importDetail = html('#importDetail')
const importDone = html('#importDone')

// Resolves once the file is saved.
async function writeBackup(auto: boolean): Promise<void> {
  const ids = store.doc.sparks.map((spark) => spark.thumb).filter((thumb) => thumb !== null)
  const blob = new Blob(exportParts(store.doc, await store.thumbs(ids)), { type: 'application/json' })
  if (blob.size > LIMITS.backupBytes) throw new LimitError('The backup would be larger than 1 GB')
  const url = URL.createObjectURL(blob)
  try {
    await saveFile(browser.downloads, url, backupName(new Date(), auto), auto)
  } finally {
    URL.revokeObjectURL(url)
  }
}

// What may not happen without a backup of what it replaces. outcome: what didn't happen, if that fails.
// False when there was nothing to keep, so no file.
async function autoBackup(outcome: string): Promise<boolean> {
  if (isVanilla(store.doc)) return false
  try {
    await writeBackup(true)
    return true
  } catch (error) {
    throw new Error(`The backup failed, so nothing was ${outcome}: ${errorText(error)}`, { cause: error })
  }
}

async function exportData(): Promise<void> {
  try {
    await writeBackup(false)
    notify('Backup exported')
  } catch (error) {
    notify(`Export failed: ${errorText(error)}`)
  }
}

async function replaceData(data: ImportedData): Promise<void> {
  active = await store.replaceAll(data)
  thumbs.clear()
  colors.clear()
  selection.clear()
}

// Without a share done, the bar just shows that something is going on.
function showImport(detail: string, share?: number): void {
  importDetail.textContent = detail
  if (share === undefined) importProgress.removeAttribute('value')
  else importProgress.value = share
}

function endImport(title: string, detail: string, button: string): void {
  importModal.title = title
  importDone.textContent = button
  importModal.dismissible = true
  importDetail.textContent = detail
  importProgress.hidden = true
  importDone.hidden = false
}

async function importFile(file: File): Promise<string> {
  if (file.size > LIMITS.backupBytes) throw new LimitError('The file is larger than 1 GB')
  showImport('Reading the file')
  const backup = readBackup(await file.text())
  showImport('Saving a backup')
  await autoBackup('imported')
  let done = 0
  const sparks = []
  for (const spark of backup.sparks) {
    sparks.push({ ...spark, src: spark.src.startsWith('data:') ? await shrinkImage(spark.src) : spark.src })
    showImport(`${++done} of ${plural(backup.sparks.length, 'spark')}`, done / backup.sparks.length)
  }
  showImport('Saving')
  await replaceData({ ...backup, sparks })
  return importSummary(backup.groups.length, sparks.length, backup.skipped)
}

// The page follows after Done, so the modal keeps its look until then.
async function runImport(file: File): Promise<void> {
  importModal.title = 'Importing'
  importModal.dismissible = false
  importProgress.hidden = false
  importDone.hidden = true
  const closed = importModal.open()
  try {
    endImport('Import complete', await importFile(file), 'Done')
  } catch (error) {
    endImport('Import failed', errorText(error), 'Close')
  }
  await closed
  await afterChange()
}

const importInput = $('#importFile', HTMLInputElement)

// Asks first, then picks the file: the click on the answer still counts as the user's for the picker.
async function askImport(): Promise<void> {
  if (await confirm.ask(IMPORT)) importInput.click()
}

importInput.addEventListener('change', () => {
  const file = importInput.files?.[0]
  importInput.value = ''
  if (file) void runImport(file)
})

// Context menu on sparks, groups and empty space. Text fields keep Firefox's menu, and
// Shift+right-click always opens Firefox's menu.

interface MenuEntry {
  icon: string
  label: string
  run: () => void
}

async function copyUrl(spark: Spark): Promise<void> {
  await navigator.clipboard.writeText(spark.url)
  notify('URL copied')
}

function openAll(group: Group): void {
  const urls = store.doc.sparks.filter((spark) => spark.groupId === group.id).map((spark) => spark.url)
  urls.forEach(openTab)
  notify(urls.length ? `Opened ${plural(urls.length, 'tab')}` : `${group.title} has no sparks`)
}

function sparkMenu(spark: Spark): MenuEntry[] {
  const open = {
    icon: 'open',
    label: 'Open in new tab',
    run: () => {
      openUrl(spark.url, true)
    }
  }
  const copy = { icon: 'copy', label: 'Copy URL', run: () => void copyUrl(spark) }
  if (narrow.matches) return [open, copy]
  return [
    open,
    { icon: 'edit', label: 'Edit', run: () => void openSparkModal(spark) },
    copy,
    { icon: 'trash', label: 'Delete', run: () => void deleteSpark(spark) }
  ]
}

function groupMenu(group: Group): MenuEntry[] {
  return [
    {
      icon: 'open',
      label: 'Open all',
      run: () => {
        openAll(group)
      }
    },
    {
      icon: 'edit',
      label: 'Rename',
      run: () => {
        if (!editing) setEditing(true)
        setActive(group.id)
        focusGroupName(group.id)
      }
    },
    ...(canDeleteGroup() ? [{ icon: 'trash', label: 'Delete', run: () => void deleteGroup(group) }] : [])
  ]
}

function pageMenu(): MenuEntry[] {
  return [
    { icon: 'plus', label: 'New spark', run: () => void openSparkModal() },
    { icon: 'plus', label: 'New group', run: startNewGroup },
    {
      icon: 'edit',
      label: editing ? 'Done' : 'Edit',
      run: () => {
        setEditing(!editing)
      }
    }
  ]
}

const menu = html('.ContextMenu')

function menuFor(node: Element): MenuEntry[] | null {
  const tile = node.closest('#sparks .Spark[data-id]')
  if (tile instanceof HTMLElement) {
    const spark = sparkById(sparkIdOf(tile))
    return spark ? sparkMenu(spark) : null
  }
  const groupEl = node.closest('.Group')
  if (groupEl instanceof HTMLElement) {
    const group = groupById(groupIdOf(groupEl))
    return group ? groupMenu(group) : null
  }
  return narrow.matches ? null : pageMenu()
}

function openMenu(event: MouseEvent, entries: readonly MenuEntry[]): void {
  event.preventDefault()
  menu.replaceChildren(
    ...entries.map(({ icon: iconName, label, run }) => {
      const entry = el('button', { type: 'button', class: 'ContextMenu__item', role: 'menuitem' }, icon(iconName), label)
      entry.addEventListener('click', () => {
        closeMenu()
        run()
      })
      return entry
    })
  )
  menu.hidden = false
  const { width, height } = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(0, Math.min(event.clientX, innerWidth - width - 4))}px`
  menu.style.top = `${Math.max(0, Math.min(event.clientY, innerHeight - height - 4))}px`
}

function closeMenu(): void {
  menu.hidden = true
}

document.addEventListener('contextmenu', (event) => {
  const target = targetOf(event)
  if (!target || target.closest('input, textarea, select, dialog')) return
  if (target.closest('.ContextMenu')) {
    event.preventDefault()
    return
  }
  const entries = menuFor(target)
  if (entries) openMenu(event, entries)
})

document.addEventListener('mousedown', (event) => {
  const target = targetOf(event)
  if (!target || !menu.contains(target)) closeMenu()
})
document.addEventListener('scroll', closeMenu, true)
window.addEventListener('blur', closeMenu)

// Edit dialog

const sparkModal = new Modal($('#sparkModal', HTMLDialogElement), 'Edit')
const sparkForm = sparkModal.form
const sparkDrop = html('.Drop', sparkForm)
const titleField = $('[name=title]', HTMLInputElement, sparkForm)
const urlField = $('[name=url]', HTMLInputElement, sparkForm)
const groupField = new Dropdown<GroupId>(html('#sparkGroup'), 'Group')
const refreshTitleClear = clearable(titleField)
const refreshUrlClear = clearable(urlField)
const fileField = $('[name=file]', HTMLInputElement, sparkForm)
const fieldOf = (input: HTMLInputElement): HTMLElement => {
  const node = input.closest('.Field')
  if (!(node instanceof HTMLElement)) throw new Error('Input outside a field')
  return node
}
const clearThumb = $('[data-action="clear-thumb"]', HTMLButtonElement, sparkForm)
let draftSrc = ''

// The preview and the clear buttons follow the draft and the fields.
function renderPreview(): void {
  const preview = { title: titleField.value, url: urlField.value }
  sparkDrop.classList.toggle('Drop--empty', !draftSrc)
  sparkDrop.replaceChildren(thumbBox(preview, draftSrc, null), ...(draftSrc ? [] : [el('div', { class: 'Drop__hint' }, 'Paste or drop a preview')]))
  clearThumb.disabled = !draftSrc
  refreshTitleClear()
  refreshUrlClear()
  titleField.placeholder = hostOf(preview.url) || 'Title'
}

async function setDraftImage(file: File | undefined): Promise<void> {
  if (!file?.type.startsWith('image/')) return
  draftSrc = await shrinkImage(await readFile(file))
  renderPreview()
}

async function openSparkModal(spark?: Spark): Promise<void> {
  sparkModal.title = spark ? 'Edit' : 'Add spark'
  html('#sparkSave', sparkForm).textContent = spark ? 'Save' : 'Add'
  titleField.value = spark?.title ?? ''
  urlField.value = spark?.url ?? ''
  fieldOf(urlField).classList.remove('Field--invalid')
  const groupId = spark?.groupId ?? active
  groupField.setChoices(groupChoices(), groupId)
  if (spark) await loadThumbs([spark])
  const srcBefore = spark ? thumbOf(spark) : ''
  draftSrc = srcBefore
  renderPreview()

  if ((await sparkModal.open()) !== 'save') return

  const url = toSparkUrl(normalizeUrl(urlField.value))
  const newGroup = groupField.value
  if (!url || newGroup === null) return
  const title = toLabel(titleField.value)
  const src = draftSrc
  const newThumb = src && src !== srcBefore ? newThumbId() : null
  const thumb = src === srcBefore ? (spark?.thumb ?? null) : newThumb
  if (newThumb) thumbs.set(newThumb, src)
  await change(
    (doc) => {
      const target = doc.sparks.find((item) => item.id === spark?.id)
      if (target) Object.assign(target, { title, url, groupId: newGroup, thumb })
      else allocSpark(doc, { groupId: newGroup, title, url, thumb })
      return undefined
    },
    newThumb ? { thumbs: { [newThumb]: src } } : {}
  )
  if (newGroup !== groupId) notify(`${spark ? 'Moved' : 'Added'} to ${groupById(newGroup)?.title ?? ''}`)
}

// No usable URL, no save: mark the field instead of a browser tooltip. Registered before the modal's listener.
sparkForm.addEventListener('submit', (event) => {
  if (urlField.value.trim() && toSparkUrl(normalizeUrl(urlField.value))) return
  event.preventDefault()
  event.stopImmediatePropagation()
  fieldOf(urlField).classList.add('Field--invalid')
  urlField.focus()
})

sparkForm.addEventListener('input', (event) => {
  if (event.target === urlField) fieldOf(urlField).classList.remove('Field--invalid')
  renderPreview()
})

fileField.addEventListener('change', () => {
  void setDraftImage(fileField.files?.[0])
  fileField.value = ''
})

sparkForm.addEventListener('paste', (event) => {
  const file = [...(event.clipboardData?.files ?? [])].find((item) => item.type.startsWith('image/'))
  if (!file) return
  event.preventDefault()
  void setDraftImage(file)
})

// Drop an image file, or an image dragged from a web page (its link).
sparkDrop.addEventListener('dragover', (event) => {
  event.preventDefault()
  event.stopPropagation()
  sparkDrop.classList.add('Drop--over')
})
sparkDrop.addEventListener('dragleave', () => {
  sparkDrop.classList.remove('Drop--over')
})
sparkDrop.addEventListener('drop', (event) => {
  event.preventDefault()
  event.stopPropagation()
  sparkDrop.classList.remove('Drop--over')
  const file = [...(event.dataTransfer?.files ?? [])].find((item) => item.type.startsWith('image/'))
  if (file) {
    void setDraftImage(file)
    return
  }
  const link = event.dataTransfer
    ?.getData('text/uri-list')
    .split('\n')
    .find((line) => line && !line.startsWith('#'))
  if (!link) return
  draftSrc = link.trim()
  renderPreview()
})

// Drag and drop: reorder sparks and groups, drop sparks onto a group to move them.

// All of it works in edit mode only: elsewhere sparks are just links.

function startDrag(next: Drag): void {
  drag = next
  document.body.classList.add('dragging')
  renderTrash()
}

const DROP_MARKS = ['Spark--drop', 'Spark--dropAfter', 'Group--drop', 'Group--dropBefore', 'Group--dropAfter']

function clearDropMarks(): void {
  for (const node of $$(DROP_MARKS.map((mark) => `.${mark}`).join(', '), Element)) node.classList.remove(...DROP_MARKS)
}

function afterHalf(node: Element, event: MouseEvent, vertical: boolean): boolean {
  const rect = node.getBoundingClientRect()
  return vertical ? event.clientY > rect.top + rect.height / 2 : event.clientX > rect.left + rect.width / 2
}

grid.addEventListener('dragstart', (event) => {
  const tile = closest(event, '.Spark[data-id]')
  const id = tile ? sparkIdOf(tile) : null
  if (!tile || id === null || !editing) {
    event.preventDefault()
    return
  }
  const ids = selection.has(id) ? new Set(selection) : new Set([id])
  startDrag({ type: 'spark', ids })
  if (event.dataTransfer) {
    const rect = tile.getBoundingClientRect()
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setDragImage(tile, event.clientX - rect.left, event.clientY - rect.top)
  }
  requestAnimationFrame(() => {
    for (const node of tiles()) {
      const nodeId = sparkIdOf(node)
      node.classList.toggle('Spark--dragging', drag?.type === 'spark' && nodeId !== null && drag.ids.has(nodeId))
    }
  })
})

grid.addEventListener('dragover', (event) => {
  if (drag?.type !== 'spark' || query) return
  const over = closest(event, '.Spark')
  if (!over) return
  const overId = sparkIdOf(over)
  if (overId !== null && drag.ids.has(overId)) return
  event.preventDefault()
  const after = overId !== null && afterHalf(over, event, false)
  clearDropMarks()
  over.classList.add(after ? 'Spark--dropAfter' : 'Spark--drop')
})

grid.addEventListener('drop', (event) => {
  const over = closest(event, '.Spark')
  if (drag?.type !== 'spark' || !over || query) return
  event.preventDefault()
  const { ids } = drag
  const targetId = sparkIdOf(over)
  const after = targetId !== null && afterHalf(over, event, false)
  endDrag()
  void reorderSparks(ids, targetId, after)
})

groupsNav.addEventListener('dragstart', (event) => {
  const groupEl = closest(event, '.Group')
  const id = groupEl ? groupIdOf(groupEl) : null
  if (!groupEl || id === null || closest(event, '.NameInput')) {
    event.preventDefault()
    return
  }
  startDrag({ type: 'group', id })
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', groupById(id)?.title ?? '')
    event.dataTransfer.setDragImage(groupEl, 16, groupEl.offsetHeight / 2)
  }
  requestAnimationFrame(() => {
    groupEl.classList.add('Group--dragging')
  })
})

groupsNav.addEventListener('dragover', (event) => {
  const over = closest(event, '.Group')
  if (!drag || !over) return
  if (drag.type === 'group' && groupIdOf(over) === drag.id) return
  event.preventDefault()
  clearDropMarks()
  if (drag.type === 'spark') over.classList.add('Group--drop')
  else over.classList.add(afterHalf(over, event, true) ? 'Group--dropAfter' : 'Group--dropBefore')
})

groupsNav.addEventListener('dragleave', (event) => {
  if (!(event.relatedTarget instanceof Node) || !groupsNav.contains(event.relatedTarget)) clearDropMarks()
})

groupsNav.addEventListener('drop', (event) => {
  const over = closest(event, '.Group')
  const target = over ? groupIdOf(over) : null
  if (!drag || !over || target === null) return
  event.preventDefault()
  const current = drag
  const after = afterHalf(over, event, true)
  endDrag()
  if (current.type === 'spark') {
    clearSelection()
    void moveSparks(current.ids, target)
  } else {
    void reorderGroup(current.id, target, after)
  }
})

function endDrag(): void {
  drag = null
  clearDropMarks()
  document.body.classList.remove('dragging')
  trash.classList.remove('Trash--over')
  renderTrash()
  for (const node of $$('.Spark--dragging, .Group--dragging', Element)) node.classList.remove('Spark--dragging', 'Group--dragging')
}

document.addEventListener('dragend', endDrag)

// The trash: anything dragged here is deleted, and an item that's marked takes all marks along.

const trash = html('#trash')

async function throwAway(dragged: Drag): Promise<void> {
  const marked = dragged.type === 'spark' ? [...dragged.ids].some((id) => selection.has(id)) : markedGroups.has(dragged.id)
  if (marked) await deleteMarked()
  else if (dragged.type === 'spark') await deleteItems(dragged.ids, new Set())
  else await deleteItems(new Set(), new Set([dragged.id]))
}

trash.addEventListener('dragover', (event) => {
  if (!drag) return
  event.preventDefault()
  trash.classList.add('Trash--over')
})

trash.addEventListener('dragleave', (event) => {
  if (!(event.relatedTarget instanceof Node) || !trash.contains(event.relatedTarget)) trash.classList.remove('Trash--over')
})

trash.addEventListener('drop', (event) => {
  if (!drag) return
  event.preventDefault()
  const dragged = drag
  endDrag()
  trash.classList.add('Trash--gulp')
  void throwAway(dragged)
})

trash.addEventListener('animationend', () => {
  trash.classList.remove('Trash--gulp')
})

// Edit mode: drag a box to select sparks and groups (Shift adds to it). It starts on empty space,
// or on a group: there it waits for the mouse to move, because a click shows the group.

const main = html('#main')
let band: { x: number; y: number; sparks: Set<SparkId>; groups: Set<GroupId>; before: Marks; box: HTMLElement | null } | null = null
let bandDrawn = false

function startBand(event: PointerEvent): void {
  const adding = event.shiftKey
  closeMenu()
  band = {
    x: event.clientX,
    y: event.clientY,
    sparks: new Set(adding ? selection : []),
    groups: new Set(adding ? markedGroups : []),
    before: marks(),
    box: null
  }
}

main.addEventListener('pointerdown', (event) => {
  if (!editing || event.button !== 0 || closest(event, '.Spark')) return
  if (event.target === main && event.offsetX >= main.clientWidth) return // scrollbar
  event.preventDefault()
  startBand(event)
  if (!event.shiftKey) clearSelection()
})

html('.Rail').addEventListener('pointerdown', (event) => {
  if (!editing || event.button !== 0 || closest(event, '.Handle, .NameInput, .NewGroup, .NewGroupInput, .Rail__resize')) return
  if (event.target === groupsNav && event.offsetX >= groupsNav.clientWidth) return // scrollbar
  startBand(event)
})

document.addEventListener('pointermove', (event) => {
  if (!band) return
  const left = Math.min(band.x, event.clientX)
  const top = Math.min(band.y, event.clientY)
  const width = Math.abs(event.clientX - band.x)
  const height = Math.abs(event.clientY - band.y)
  if (!band.box) {
    if (width < 4 && height < 4) return
    band.box = document.body.appendChild(el('div', { class: 'Band' }))
  }
  Object.assign(band.box.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` })
  const inBox = (node: Element): boolean => {
    const rect = node.getBoundingClientRect()
    return rect.left < left + width && rect.right > left && rect.top < top + height && rect.bottom > top
  }
  const sparks = new Set(band.sparks)
  const groups = new Set(band.groups)
  for (const tile of tiles().filter(inBox)) {
    const id = sparkIdOf(tile)
    if (id !== null) sparks.add(id)
  }
  for (const row of $$('.Group', HTMLElement).filter(inBox)) {
    const id = groupIdOf(row)
    if (id !== null) groups.add(id)
  }
  setSelection(sparks, groups)
})

const endBand = (): void => {
  if (band?.box) {
    selectionTrail.record(band.before, marks())
    band.box.remove()
    bandDrawn = true // the click that ends a box is no click on what's under it
    setTimeout(() => {
      bandDrawn = false
    }, 0)
  }
  band = null
  renderHistory()
}
document.addEventListener('pointerup', endBand)
document.addEventListener('pointercancel', endBand)

// Clicks and keyboard

const actions: Readonly<Record<string, (event: Event) => void>> = {
  undo: () => void undo(),
  redo: () => void redo(),
  'toggle-edit': () => {
    setEditing(!editing)
  },
  'new-group': startNewGroup,
  trash: () => {
    if (markCount()) void deleteMarked()
    else notify('Drag sparks or groups here to delete them')
  },
  export: () => void exportData(),
  import: () => void askImport(),
  upload: () => {
    fileField.click()
  },
  'clear-thumb': () => {
    draftSrc = ''
    renderPreview()
  },
  about: () => {
    openAbout()
  },
  'ask-delete-everything': () => void askFromAbout(DELETE_EVERYTHING, deleteEverything),
  'ask-reset-settings': () => void askFromAbout(RESET_SETTINGS, resetSettings),
  'ask-start-over': () => void askFromAbout(START_OVER, startOver),
  reload: () => {
    location.reload()
  }
}

document.addEventListener('click', (event) => {
  const action = closest(event, '[data-action]')?.dataset['action']
  const run = action ? actions[action] : undefined
  if (run) {
    run(event)
    return
  }

  const setting = closest(event, '[data-setting] > button')
  const name = setting?.parentElement?.dataset['setting']
  const value = setting?.dataset['value']
  if (name && value) {
    if (name === 'color') honeycombPanel.hidden = value !== 'custom' || !honeycombPanel.hidden
    void changePrefs((prefs) => {
      applySetting(prefs, name, value)
    })
    return
  }

  const cell = closest(event, '.Hex')?.dataset['hex']
  if (cell) {
    setCustomColor(cell)
    return
  }

  const add = closest(event, '#sparks .AddSpark')
  if (add) {
    openAddTile(add)
    return
  }

  const tile = closest(event, '#sparks .Spark[data-id]')
  if (tile) {
    const spark = sparkById(sparkIdOf(tile))
    if (!spark) return
    if (closest(event, '.EditSpark')) {
      event.preventDefault()
      void openSparkModal(spark)
    } else if (editing) {
      event.preventDefault()
      toggleTile(tile, event.shiftKey)
    } else if (isBlocked(spark.url)) {
      event.preventDefault()
      void copyBlocked(spark.url)
    }
    return // the link opens the spark
  }

  const groupEl = closest(event, '.Group')
  const group = groupEl ? groupById(groupIdOf(groupEl)) : undefined
  if (group && !bandDrawn && !closest(event, '.NameInput')) setActive(group.id)
})

document.addEventListener('auxclick', (event) => {
  const tile = closest(event, '#sparks .Spark[data-id]')
  if (event.button !== 1 || !tile) return
  const url = sparkById(sparkIdOf(tile))?.url ?? ''
  if (editing || isBlocked(url)) event.preventDefault()
  if (!editing && isBlocked(url)) void copyBlocked(url)
})

const ARROW_STEPS: Readonly<Record<string, number | 'down' | 'up'>> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 'down', ArrowUp: 'up' }

document.addEventListener('keydown', (event) => {
  if (document.querySelector('dialog[open]') || isTyping()) return

  const key = event.key.toLowerCase()
  const mod = event.ctrlKey || event.metaKey
  if (event.key === 'Escape') {
    closeMenu()
    if (markCount()) changeSelection([], [])
    else if (editing) setEditing(false)
    else if (query) clearSearch()
    return
  }
  if (mod && (key === 'z' || key === 'y') && editing && !narrow.matches) {
    event.preventDefault()
    void (key === 'y' || event.shiftKey ? redo() : undo())
    return
  }
  if (mod && key === 'a' && editing) {
    event.preventDefault()
    changeSelection([...selection, ...visibleSparks().map((spark) => spark.id)])
    return
  }

  const focused = document.activeElement
  const groupEl = focused?.closest('.Group')
  if (groupEl instanceof HTMLElement && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault()
    const id = groupIdOf(groupEl)
    if (id !== null) setActive(id)
    return
  }
  if (focused instanceof HTMLElement && focused.matches('.AddSpark') && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault()
    openAddTile(focused)
    return
  }

  if (event.key === 'Delete' && markCount()) {
    event.preventDefault()
    void deleteMarked()
    return
  }

  const tile = focused?.closest('#sparks .Spark')
  const step = ARROW_STEPS[event.key]
  if (tile instanceof HTMLElement && step !== undefined) {
    event.preventDefault()
    const all = $$('#sparks .Spark', HTMLElement)
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length
    const offset = step === 'down' ? columns : step === 'up' ? -columns : step
    const index = all.indexOf(tile) + offset
    if (index < 0) searchInput.focus()
    else all[Math.min(index, all.length - 1)]?.focus()
  } else if (event.key === '/' && !mod) {
    event.preventDefault()
    searchInput.focus()
  }
})

// Other tabs and the background change the store too. Tabs follow along, except while hidden
// or while the user is typing here: then the change waits so it doesn't take the input away.

async function followStore(): Promise<void> {
  if (document.hidden || isTyping()) {
    stale = true
    return
  }
  stale = false
  if (await store.refresh()) await afterChange()
}

document.addEventListener('visibilitychange', () => {
  if (stale) void followStore()
})
document.addEventListener('focusout', () => {
  if (stale) setTimeout(() => void followStore(), 0)
})

function openAbout(): void {
  html('#aboutVersion').textContent = `FireDial ${browser.runtime.getManifest().version}`
  void aboutModal.open()
}

const aboutModal = new Modal($('#aboutModal', HTMLDialogElement), 'FireDial')
const confirm = new Confirm()

const IMPORT: Question = { title: 'Import', text: 'Import a backup. This will replace all FireDial bookmarks, sparks and groups.', button: 'Import' }
const DELETE_EVERYTHING: Question = {
  title: 'Delete all',
  text: 'Delete all. This will delete all FireDial bookmarks, sparks and groups.',
  button: 'Delete all'
}
const START_OVER: Question = {
  title: 'Start over',
  text: 'Start over with the sparks and settings FireDial comes with. This will replace all FireDial bookmarks, sparks and groups.',
  button: 'Start over'
}
const RESET_SETTINGS: Question = {
  title: 'Reset settings',
  text: 'Reset settings back to their defaults. This is safe for bookmarks, sparks and groups.',
  button: 'Reset settings'
}

// One modal at a time: the question replaces About, and Cancel brings it back.
async function askFromAbout(question: Question, run: () => Promise<void>): Promise<void> {
  aboutModal.close()
  if (await confirm.ask(question)) await run()
  else void aboutModal.open()
}

async function resetSettings(): Promise<void> {
  await changePrefs((prefs) => {
    Object.assign(prefs, DEFAULT_PREFS)
  })
  notify('Settings reset')
}

// The bookmarks in the FireDial folder go too: left there, they would come back as sparks.
async function deleteEverything(): Promise<void> {
  try {
    const saved = await autoBackup('deleted')
    await replaceData({ groups: [], sparks: [], prefs: { ...DEFAULT_PREFS } })
    setEditing(false)
    await afterChange()
    if (saved) notify('Backup saved')
    notify('Everything deleted')
  } catch (error) {
    notify(errorText(error))
  }
}

// As a fresh install: the sparks in defaults.json and the default settings.
async function startOver(): Promise<void> {
  try {
    const defaults = readBackup(await (await fetch(browser.runtime.getURL('defaults.json'))).text())
    const saved = await autoBackup('replaced')
    await replaceData(defaults)
    setEditing(false)
    await afterChange()
    if (saved) notify('Backup saved')
    notify('Started over')
  } catch (error) {
    notify(errorText(error))
  }
}

async function start(): Promise<void> {
  if (!('browser' in globalThis)) throw new Error('browser API missing')
  const [, { activeGroup, reveal }, stored] = await Promise.all([store.load(), browserKeyValue.get(['activeGroup', 'reveal']), store.colors()])
  active = isGroupId(activeGroup) && groupById(activeGroup) ? activeGroup : firstGroupId()
  revealing = isSparkId(reveal) ? reveal : null
  for (const [id, color] of stored) colors.set(id, color)
}

// Opened from the toast of a spark just added: shows it, without entering edit mode.
function revealSpark(id: SparkId): void {
  void browserKeyValue.remove('reveal')
  const tile = document.querySelector(`#sparks .Spark[data-id="${id}"]`)
  tile?.scrollIntoView({ block: 'center' })
  tile?.classList.add('Spark--reveal')
}

// Shows the stored data once it's read, however long that takes. No timeout, no automatic
// reload, no placeholder data: if reading fails, the page says so and shows nothing else.
async function init(): Promise<void> {
  try {
    await start()
  } catch (error) {
    console.error('FireDial start failed:', error)
    html('#bootError').hidden = false
    document.documentElement.classList.remove('Booting')
    return
  }
  applyNarrow()
  await render()
  document.documentElement.classList.remove('Booting')
  if (revealing !== null) revealSpark(revealing)
  store.watch(() => void followStore())
  void loadEngines()
}

void init()
