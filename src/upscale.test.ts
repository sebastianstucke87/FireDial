import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { undouble, upscale } from './upscale.ts'
import type { Pixels } from './upscale.ts'

// An image from a picture of characters: # black, . white, space transparent.
function image(rows: string[]): Pixels {
  const width = rows[0]?.length ?? 0
  const data = new Uint8ClampedArray(width * rows.length * 4)
  rows.forEach((row, y) => {
    row.split('').forEach((char, x) => {
      const value = char === '#' ? [0, 0, 0, 255] : char === '.' ? [255, 255, 255, 255] : [0, 0, 0, 0]
      data.set(value, (y * width + x) * 4)
    })
  })
  return { data, width, height: rows.length }
}

const pixel = ({ data, width }: Pixels, x: number, y: number): number[] => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]

// Every pixel doubled, as Chrome's 64 px copies of its 32 px icons are.
function doubled({ data, width, height }: Pixels): Pixels {
  const out = new Uint8ClampedArray(width * height * 16)
  for (let y = 0; y < height * 2; y++)
    for (let x = 0; x < width * 2; x++)
      out.set(data.subarray(((y >> 1) * width + (x >> 1)) * 4, ((y >> 1) * width + (x >> 1)) * 4 + 4), (y * width * 2 + x) * 4)
  return { data: out, width: width * 2, height: height * 2 }
}

// 32 px of a diagonal: black above it, white below.
const diagonal = image(Array.from({ length: 32 }, (_, y) => Array.from({ length: 32 }, (_, x) => (x > y ? '#' : '.')).join('')))

test('doubled pixels are halved back, as often as they were doubled', () => {
  const back = undouble(doubled(doubled(diagonal)))
  assert.equal(back.width, 32)
  assert.deepEqual([...back.data], [...diagonal.data])
  assert.equal(undouble(diagonal).width, 32, 'an image of its own pixels stays')
})

test('a small icon comes out at least 192 px wide, a big one as it is', () => {
  const big = upscale(diagonal)
  assert.deepEqual([big.width, big.height], [256, 256])
  assert.equal(upscale(doubled(diagonal)).width, 256, 'undoubled first')
  const wide = image(Array.from({ length: 256 }, () => '#'.repeat(256)))
  assert.equal(upscale(wide).data, wide.data, 'nothing to do')
})

test('flat colors stay as they are, transparency too', () => {
  const big = upscale(image(['##..', '##..', '    ', '    ']), 8)
  assert.deepEqual(pixel(big, 0, 0), [0, 0, 0, 255])
  assert.deepEqual(pixel(big, 7, 0), [255, 255, 255, 255])
  assert.deepEqual(pixel(big, 3, 7), [0, 0, 0, 0])
})

test('a diagonal edge is smoothed: the pixels along it are in between, no stairs', () => {
  const big = upscale(diagonal, 64)
  // Along the edge, the doubled stairs' corners are mixed; plain doubling would only know black and white.
  const along = Array.from({ length: 60 }, (_, n) => pixel(big, n + 2, n + 1)[0] ?? 0)
  assert.ok(
    along.some((value) => value > 0 && value < 255),
    along.join()
  )
  // Away from it, it's still black and white.
  assert.deepEqual(pixel(big, 60, 2), [0, 0, 0, 255])
  assert.deepEqual(pixel(big, 2, 60), [255, 255, 255, 255])
})

// Test pictures with every kind of edge: drawn by formula, so they need no files.
function drawn(width: number, height: number, color: (x: number, y: number) => readonly [number, number, number, number]): Pixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4)
  return { data, width, height }
}

let seed = 7
const random = (): number => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31
  return seed / 2 ** 31
}
const palette = [
  [230, 60, 40, 255],
  [30, 120, 230, 255],
  [255, 255, 255, 255],
  [0, 0, 0, 0],
  [40, 200, 120, 128]
] as const

const pictures = {
  // a round logo: a blue disc with a soft edge on a transparent ground
  disc: drawn(24, 24, (x, y) => {
    const inside = Math.max(0, Math.min(1, 10 - Math.hypot(x - 11.5, y - 11.5)))
    return [30, 120, 230, Math.round(inside * 255)]
  }),
  // flat edges, a third and three times as steep as a diagonal, in two colors
  slopes: drawn(20, 12, (x, y) => (y > x / 3 + 2 ? [230, 60, 40, 255] : x > y * 3 - 10 ? [255, 255, 255, 255] : [20, 20, 20, 255])),
  // a cross of bars, one color running into another
  cross: drawn(10, 16, (x, y) => (x >= 4 && x <= 5 ? [0, 0, 0, 255] : y >= 7 && y <= 8 ? [240, 200, 0, 255] : [255, 255, 255, 255])),
  // noise of a few colors: every rule of the edges at work
  noise: drawn(16, 16, () => palette[Math.floor(random() * palette.length)] ?? [0, 0, 0, 0])
}

// The upscaled pictures' pixels as this version made them, checked by eye: any change to the edges shows.
const EXPECTED: Record<string, string> = {
  cross: '20x32 87e5199204e2e85c',
  disc: '48x48 3460bbd6d01fe1cb',
  noise: '32x32 1e5add1c3dad4a09',
  slopes: '40x24 bdf1892aeebbc8e4',
  'disc, all the way': '192x192 175ebde37233cc2c'
}

const sum = (big: Pixels): string => `${big.width}x${big.height} ${createHash('sha256').update(big.data).digest('hex').slice(0, 16)}`

test('the test pictures upscale exactly as before', () => {
  const sums = Object.fromEntries(
    Object.entries(pictures).map(([name, picture]) => {
      const big = upscale(picture, 2 * picture.width)
      return [name, sum(big)]
    })
  )
  sums['disc, all the way'] = sum(upscale(pictures.disc))
  assert.deepEqual(sums, EXPECTED)
})

test('undoubling stops at 16 px, and at odd sizes; it works on any shape', () => {
  const small = drawn(8, 8, (x, y) => (x > y ? [0, 0, 0, 255] : [255, 255, 255, 255]))
  assert.equal(undouble(doubled(doubled(small))).width, 16, 'not below 16 px')
  const odd = drawn(17, 18, (x) => [x * 10, 0, 0, 255])
  assert.equal(undouble(doubled(odd)).width, 17, 'back to the odd size, not further')
  const tall = drawn(10, 20, (x, y) => [x * 20, y * 10, 0, 255])
  assert.deepEqual([undouble(doubled(tall)).width, undouble(doubled(tall)).height], [10, 20])
  const wide = drawn(20, 9, (x, y) => [x * 10, y * 20, 0, 255])
  assert.deepEqual([undouble(doubled(wide)).width, undouble(doubled(wide)).height], [20, 9], 'an odd height stops it')
})

test('an image as wide as asked stays; a doubled one is undoubled first', () => {
  const exact = drawn(32, 32, (x) => [x * 8, 0, 0, 255])
  assert.equal(upscale(exact, 32), exact)
  const back = upscale(doubled(exact), 32 * 3)
  assert.deepEqual([back.width, back.height], [128, 128])
})
