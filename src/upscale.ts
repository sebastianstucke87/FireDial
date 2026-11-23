// Small icons drawn big without the blur: xBR (Hyllian's), doubling the size until it's big enough.
// It looks along each pixel's edges and fills the new pixels along them, so a logo's diagonals and
// curves stay smooth lines instead of soft or stair-stepped ones. Colors are blended with their
// transparency taken in (premultiplied), so transparent edges don't turn dark.

export interface Pixels {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
}

const UPSCALE_TO = 192 // px wide at least, once upscaled: sharp in Square, on scaled displays too
const SAME = 48 * 10 // a distance under this is the same color

// An image of pixels that each came doubled (Chrome's copies at 64 px are its 32 px ones), halved
// back, as often as it was doubled.
export function undouble(image: Pixels): Pixels {
  let { data, width, height } = image
  for (;;) {
    if (width % 2 || height % 2 || width <= 16) return { data, width, height }
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const at = (y * width + x) * 4
        for (const other of [at + 4, at + width * 4, at + width * 4 + 4]) {
          for (let k = 0; k < 4; k++) if (data[at + k] !== data[other + k]) return { data, width, height }
        }
      }
    }
    const half = new Uint8ClampedArray((width / 2) * (height / 2) * 4)
    for (let y = 0; y < height / 2; y++) {
      for (let x = 0; x < width / 2; x++) half.set(data.subarray((y * 2 * width + x * 2) * 4, (y * 2 * width + x * 2) * 4 + 4), (y * (width / 2) + x) * 4)
    }
    data = half
    width /= 2
    height /= 2
  }
}

// Premultiplied colors, 4 numbers a pixel.
function premultiplied(data: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(data.length)
  for (let at = 0; at < data.length; at += 4) {
    const alpha = (data[at + 3] ?? 0) / 255
    out[at] = (data[at] ?? 0) * alpha
    out[at + 1] = (data[at + 1] ?? 0) * alpha
    out[at + 2] = (data[at + 2] ?? 0) * alpha
    out[at + 3] = data[at + 3] ?? 0
  }
  return out
}

function straight(data: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length)
  for (let at = 0; at < data.length; at += 4) {
    const alpha = data[at + 3] ?? 0
    const scale = alpha > 0 ? 255 / alpha : 0
    out[at] = (data[at] ?? 0) * scale
    out[at + 1] = (data[at + 1] ?? 0) * scale
    out[at + 2] = (data[at + 2] ?? 0) * scale
    out[at + 3] = alpha
  }
  return out
}

// The neighbours of a pixel xBR looks at, as (x, y) steps for its bottom right corner; the other
// three corners are the same turned by a quarter each time.
//        b  c
//     d  e  f  f4
//     g  h  i  i4
//        h5 i5
const turn = ([x, y]: readonly [number, number], times: number): [number, number] => {
  let point: [number, number] = [x, y]
  for (let n = 0; n < times; n++) point = [-point[1], point[0]]
  return point
}

// The neighbours' steps, in the order E B C D F F4 G H I I4 H5 I5, for each corner turned.
const STEPS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [2, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
  [2, 1],
  [0, 2],
  [1, 2]
]
// Flat, for speed: the x and y steps of corner t's neighbour n at t * 12 + n; its corner, left and
// up cells of the 2x2 block (as x + 2 * y) at t * 3, t * 3 + 1, t * 3 + 2.
const TURNED = [0, 1, 2, 3].flatMap((times) => STEPS.map((step) => turn(step, times)))
const STEP_X = Int8Array.from(TURNED, ([x]) => x)
const STEP_Y = Int8Array.from(TURNED, ([, y]) => y)
const CELLS = Uint8Array.from(
  [0, 1, 2, 3].flatMap((times) => [turn([1, 1], times), turn([-1, 1], times), turn([1, -1], times)]),
  ([x, y]) => (x > 0 ? 1 : 0) + (y > 0 ? 2 : 0)
)

// One xBR doubling, of premultiplied pixels.
function double(src: Float32Array, width: number, height: number): Float32Array {
  const outWidth = width * 2
  const out = new Float32Array(outWidth * height * 2 * 4)
  // Each pixel's brightness, two color differences and transparency, weighted: distances are their sums.
  const yuva = new Float32Array(width * height * 4)
  for (let at = 0; at < src.length; at += 4) {
    const r = src[at] ?? 0
    const g = src[at + 1] ?? 0
    const b = src[at + 2] ?? 0
    yuva[at] = 48 * (0.299 * r + 0.587 * g + 0.114 * b)
    yuva[at + 1] = 7 * (-0.169 * r - 0.331 * g + 0.5 * b)
    yuva[at + 2] = 6 * (0.5 * r - 0.419 * g - 0.081 * b)
    yuva[at + 3] = 48 * (src[at + 3] ?? 0)
  }
  const distance = (a: number, b: number): number =>
    Math.abs((yuva[a] ?? 0) - (yuva[b] ?? 0)) +
    Math.abs((yuva[a + 1] ?? 0) - (yuva[b + 1] ?? 0)) +
    Math.abs((yuva[a + 2] ?? 0) - (yuva[b + 2] ?? 0)) +
    Math.abs((yuva[a + 3] ?? 0) - (yuva[b + 3] ?? 0))
  const same = (a: number, b: number): boolean => distance(a, b) < SAME
  const blend = (cell: number, from: number, amount: number): void => {
    for (let k = 0; k < 4; k++) out[cell + k] = (out[cell + k] ?? 0) * (1 - amount) + (src[from + k] ?? 0) * amount
  }
  const p = new Int32Array(12)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const top = (y * 2 * outWidth + x * 2) * 4
      for (let k = 0; k < 4; k++) {
        const value = src[at + k] ?? 0
        out[top + k] = value
        out[top + 4 + k] = value
        out[top + outWidth * 4 + k] = value
        out[top + outWidth * 4 + 4 + k] = value
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let times = 0; times < 4; times++) {
        const at = (n: number): number => {
          const dx = STEP_X[times * 12 + n] ?? 0
          const dy = STEP_Y[times * 12 + n] ?? 0
          return (Math.min(height - 1, Math.max(0, y + dy)) * width + Math.min(width - 1, Math.max(0, x + dx))) * 4
        }
        // Most pixels are where the color doesn't change: done before looking further.
        const e = at(0)
        const h = at(7)
        const f = at(4)
        if (same(e, h) || same(e, f)) continue
        for (const n of [1, 2, 3, 5, 6, 8, 9, 10, 11]) p[n] = at(n)
        const b = p[1] ?? 0
        const c = p[2] ?? 0
        const d = p[3] ?? 0
        const f4 = p[5] ?? 0
        const g = p[6] ?? 0
        const i = p[8] ?? 0
        const i4 = p[9] ?? 0
        const h5 = p[10] ?? 0
        const i5 = p[11] ?? 0
        const along = distance(e, c) + distance(e, g) + distance(i, h5) + distance(i, f4) + 4 * distance(h, f)
        const across = distance(h, d) + distance(h, i5) + distance(f, i4) + distance(f, b) + 4 * distance(e, i)
        if (along >= across) continue
        if (!((!same(f, b) && !same(h, d)) || (same(e, i) && !same(f, i4) && !same(h, i5)) || same(e, g) || same(e, c))) continue
        const pick = distance(e, f) <= distance(e, h) ? f : h
        const ke = distance(f, g)
        const ki = distance(h, c)
        const shallow = 2 * ke <= ki && !same(e, g) && !same(d, g) // the edge runs flat along the bottom
        const steep = ke >= 2 * ki && !same(e, c) && !same(b, c) // the edge runs up along the side
        const block = (y * 2 * outWidth + x * 2) * 4
        const cellAt = (cell: number): number => block + ((cell & 1) + (cell >> 1) * outWidth) * 4
        const corner = CELLS[times * 3] ?? 3
        const left = CELLS[times * 3 + 1] ?? 2
        const up = CELLS[times * 3 + 2] ?? 1
        if (shallow && steep) {
          blend(cellAt(corner), pick, 7 / 8)
          blend(cellAt(left), pick, 1 / 4)
          blend(cellAt(up), pick, 1 / 4)
        } else if (shallow) {
          blend(cellAt(corner), pick, 3 / 4)
          blend(cellAt(left), pick, 1 / 4)
        } else if (steep) {
          blend(cellAt(corner), pick, 3 / 4)
          blend(cellAt(up), pick, 1 / 4)
        } else blend(cellAt(corner), pick, 1 / 2)
      }
    }
  }
  return out
}

// A small image, made big: undoubled, then doubled by xBR until it's UPSCALE_TO wide.
export function upscale(image: Pixels, to: number = UPSCALE_TO): Pixels {
  if (image.width >= to) return image
  let { data, width, height } = undouble(image)
  if (width >= to) return { data, width, height }
  let pixels = premultiplied(data)
  while (width < to) {
    pixels = double(pixels, width, height)
    width *= 2
    height *= 2
  }
  return { data: straight(pixels), width, height }
}
