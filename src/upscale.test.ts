import assert from 'node:assert/strict'
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
