import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contrast, honeycomb, mainColor, markOn, textOn, labelColor } from './color.ts'

type Pixel = readonly [number, number, number, number]

const RED: Pixel = [200, 10, 10, 255]
const WHITE: Pixel = [255, 255, 255, 255]
const CLEAR: Pixel = [0, 0, 0, 0]

// A size x size image, inner pixels in one color, the outer ring in another.
const image = (size: number, inner: Pixel, ring: Pixel): number[] =>
  Array.from({ length: size * size }, (_, index) => {
    const [x, y] = [index % size, Math.floor(index / size)]
    return x === 0 || y === 0 || x === size - 1 || y === size - 1 ? ring : inner
  }).flat()

test('a plain image has its own color', () => {
  assert.equal(mainColor(image(8, RED, RED), 8, 8), '#c80a0a')
})

test('the edge outweighs the middle: the fill carries the image on', () => {
  assert.equal(mainColor(image(8, RED, WHITE), 8, 8), '#ffffff')
})

test('a logo without a background gets a pale shade, or it would vanish', () => {
  assert.equal(mainColor(image(8, RED, CLEAR), 8, 8), '#f1c2c2')
})

test('a light logo without a background gets a dark shade', () => {
  assert.equal(mainColor(image(8, WHITE, CLEAR), 8, 8), '#404040')
})

test('an image that is see-through all over has no color', () => {
  assert.equal(mainColor(image(8, CLEAR, CLEAR), 8, 8), null)
})

test('text stays readable on any color', () => {
  assert.equal(textOn('#c2410c'), '#ffffff')
  assert.equal(textOn('#3f3f46'), '#ffffff')
  assert.equal(textOn('#fde047'), '#000000')
  assert.equal(textOn('#ffffff'), '#000000')
})

test('the honeycomb is a hexagon of different colors', () => {
  const rows = honeycomb()
  assert.deepEqual(
    rows.map((row) => row.length),
    [4, 5, 6, 7, 6, 5, 4]
  )
  assert.equal(new Set(rows.flat()).size, 37)
  assert.ok(rows.flat().every((color) => /^#[0-9a-f]{6}$/.test(color)))
})

test('text reaches 4.5:1 on every color', () => {
  const steps = ['00', '33', '66', '77', '80', '99', 'cc', 'ff']
  for (const red of steps) {
    for (const green of steps) {
      for (const blue of steps) {
        const color = `#${red}${green}${blue}`
        assert.ok(contrast(color, textOn(color)) >= 4.5, color)
      }
    }
  }
})

test('contrast follows WCAG', () => {
  assert.equal(contrast('#000000', '#ffffff'), 21)
  assert.equal(contrast('#ffffff', '#000000'), 21)
  assert.equal(contrast('#123456', '#123456'), 1)
})

test('contrast reads short hex colors, as the stylesheet writes them', () => {
  assert.equal(contrast('#000', '#fff'), 21)
  assert.equal(contrast(' #fff', '#ffffff'), 1)
  assert.equal(markOn('#1d4ed8', ['#fff', '#f4f4f5'], 'text'), '#1d4ed8')
})

test('a line keeps the color unless it would vanish', () => {
  const page = ['#ffffff', '#f4f4f5']
  assert.equal(markOn('#1d4ed8', page, 'text'), '#1d4ed8')
  assert.equal(markOn('#ffffff', page, 'text'), 'text')
  assert.equal(markOn('#ffff00', page, 'text'), 'text')
  assert.equal(markOn('#000000', ['#222226', '#17171a'], 'text'), 'text')
})

// A picture from a grid: W white, R red, . see-through.
const grid = (...rows: string[]): number[] => rows.flatMap((row) => row.split('').flatMap((cell) => (cell === 'W' ? WHITE : cell === 'R' ? RED : CLEAR)))

test('each side of the edge outweighs the middle', () => {
  const red = '#f1c2c2' // a pale red: the picture is mostly see-through
  const sides = [
    ['.....', 'W.RR.', 'W.R..', 'W.RR.', '.....'],
    ['.WWW.', '..RR.', '..R..', '..RR.', '.....'],
    ['.....', '.RR.W', '.R..W', '.RR.W', '.....'],
    ['.....', '..RR.', '..R..', '..RR.', '.WWW.']
  ]
  for (const side of sides) assert.equal(mainColor(grid(...side), 5, 5), '#404040', side.join('/'))
  assert.equal(mainColor(grid('.....', '..RR.', '..R..', '..RR.', '.....'), 5, 5), red)
})

test('the heavier color wins, and of two as heavy the first', () => {
  assert.equal(mainColor(grid('RWW'), 3, 1), '#ffffff')
  assert.equal(mainColor(grid('RW'), 2, 1), '#c80a0a')
})

test('a logo is an image with at least a tenth see-through, half see-through counts as solid', () => {
  const almost = Array.from({ length: 100 }, (_, index) => (index < 9 ? '.' : 'R')).join('')
  const tenth = Array.from({ length: 100 }, (_, index) => (index < 10 ? '.' : 'R')).join('')
  assert.equal(mainColor(grid(...(almost.match(/.{10}/g) ?? [])), 10, 10), '#c80a0a')
  assert.equal(mainColor(grid(...(tenth.match(/.{10}/g) ?? [])), 10, 10), '#f1c2c2')
  assert.equal(mainColor([10, 20, 30, 128], 1, 1), '#0a141e')
})

test('a logo is lightened or darkened by its brightness, blue included', () => {
  const logo = (color: Pixel): number[] => image(8, color, CLEAR)
  assert.equal(mainColor(logo([150, 170, 200, 255]), 8, 8), '#262b32')
  assert.equal(mainColor(logo([160, 160, 160, 255]), 8, 8), '#e7e7e7')
})

test('dark channels count as dark', () => {
  assert.ok(contrast('#0a0a0a', '#000000') < 1.1)
})

test('a line keeps the color only if it shows on every background', () => {
  assert.equal(markOn('#fefefe', ['#ffffff', '#000000'], 'text'), 'text')
})

test('the honeycomb goes around the center in hue, deeper outwards', () => {
  assert.deepEqual(honeycomb(), [
    ['#1010c6', '#4a10c6', '#8c10c6', '#c610c6'],
    ['#104ac6', '#2f2fee', '#8f2fee', '#ee2fee', '#c6108c'],
    ['#108cc6', '#2f8fee', '#7b7bf4', '#f47bf4', '#ee2f8f', '#c6104a'],
    ['#10c6c6', '#2feeee', '#7bf4f4', '#3f3f46', '#f47b7b', '#ee2f2f', '#c61010'],
    ['#10c68c', '#2fee8f', '#7bf47b', '#f4f47b', '#ee8f2f', '#c64a10'],
    ['#10c64a', '#2fee2f', '#8fee2f', '#eeee2f', '#c68c10'],
    ['#10c610', '#4ac610', '#8cc610', '#c6c610']
  ])
})

test('a label keeps its pastel, labels differ, and none comes near the accent', () => {
  const names = ['docs', 'docs:api', 'web', 'news', 'work', 'home', 'linux', 'music', 'maps', 'books', 'code', 'social']
  for (const accent of ['#c2410c', '#be123c', '#1d4ed8', '#0f766e', '#3f3f46']) {
    assert.equal(labelColor('docs', accent), labelColor('docs', accent))
    const colors = names.map((name) => labelColor(name, accent))
    assert.ok(new Set(colors).size === names.length, colors.join())
    for (const color of colors) {
      assert.match(color, /^#[0-9a-f]{6}$/)
      assert.equal(textOn(color), '#000000', `${color} is light enough for dark text`)
      assert.ok(contrast(color, accent) > 1.5 || accent === '#3f3f46', `${color} next to ${accent}`)
    }
  }
})

test('the hues spread out instead of bunching', () => {
  const hues = ['docs', 'web', 'news', 'work', 'home', 'linux', 'music', 'maps', 'books', 'code', 'social', 'games'].map((name) => {
    const color = labelColor(name, '#3f3f46')
    const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16))
    return Math.round(Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * (180 / Math.PI) + 360) % 360
  })
  const sextants = new Set(hues.map((hue) => Math.floor(hue / 60)))
  assert.ok(sextants.size >= 5, hues.join())
})
