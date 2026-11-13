// Working with colors: the main color of an image, which fills the space around it in a tile,
// the text color that reads on a color, and the custom color's honeycomb.

const EDGE_WEIGHT = 4 // the color carries the image's edge on, so the edge counts most
const SOLID_ALPHA = 128
const LOGO_TRANSPARENCY = 0.1 // this share of see-through pixels means a logo without a background
const LOGO_MIX = 0.75 // on its own color a logo would vanish, so it gets a pale or dark shade of it
const LIGHT_LOGO = 160 // brightness, 0-255

interface Bucket {
  weight: number
  red: number
  green: number
  blue: number
}

const hex = (value: number): string => Math.round(value).toString(16).padStart(2, '0')
const shade = (value: number, target: number): number => value + (target - value) * LOGO_MIX

// pixels: RGBA, as in ImageData. null when the image is see-through all over.
export function mainColor(pixels: ArrayLike<number>, width: number, height: number): string | null {
  const buckets = new Map<number, Bucket>()
  let seeThrough = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      if ((pixels[index + 3] ?? 0) < SOLID_ALPHA) {
        seeThrough += 1
        continue
      }
      const [red, green, blue] = [pixels[index] ?? 0, pixels[index + 1] ?? 0, pixels[index + 2] ?? 0]
      const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4)
      const weight = x === 0 || y === 0 || x === width - 1 || y === height - 1 ? EDGE_WEIGHT : 1
      const bucket = buckets.get(key) ?? { weight: 0, red: 0, green: 0, blue: 0 }
      buckets.set(key, {
        weight: bucket.weight + weight,
        red: bucket.red + red * weight,
        green: bucket.green + green * weight,
        blue: bucket.blue + blue * weight
      })
    }
  }
  const top = [...buckets.values()].reduce<Bucket | null>((best, bucket) => (!best || bucket.weight > best.weight ? bucket : best), null)
  if (!top) return null
  const [red, green, blue] = [top.red / top.weight, top.green / top.weight, top.blue / top.weight]
  if (seeThrough / (width * height) < LOGO_TRANSPARENCY) return `#${hex(red)}${hex(green)}${hex(blue)}`
  const target = 0.299 * red + 0.587 * green + 0.114 * blue > LIGHT_LOGO ? 0 : 255
  return `#${hex(shade(red, target))}${hex(shade(green, target))}${hex(shade(blue, target))}`
}

// #rgb or #rrggbb, as CSS custom properties hand them over: the stylesheet uses both.
function luminance(hexColor: string): number {
  const digits = hexColor.trim().slice(1)
  const full = digits.length === 3 ? digits.replace(/./g, '$&$&') : digits
  const [red, green, blue] = [0, 2, 4].map((start) => {
    const channel = Number.parseInt(full.slice(start, start + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0)
}

const MARK_CONTRAST = 1.5 // below this, a line or an icon is as good as gone

// The WCAG contrast of two colors: 1 for the same color, 21 for black on white.
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

// The text color for a background. Pure black or white: one of them always reaches 4.5:1.
export const textOn = (background: string): string => (contrast(background, '#000000') > contrast(background, '#ffffff') ? '#000000' : '#ffffff')

// A color for lines and icons: the color itself, unless it would vanish on one of the backgrounds.
export const markOn = (color: string, backgrounds: readonly string[], fallback: string): string =>
  backgrounds.every((background) => contrast(color, background) >= MARK_CONTRAST) ? color : fallback

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const amount = saturation * Math.min(lightness, 1 - lightness)
  const channel = (offset: number): string => {
    const turn = (offset + hue / 30) % 12
    return hex(255 * (lightness - amount * Math.max(-1, Math.min(turn - 3, 9 - turn, 1))))
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

const LABEL_AWAY = 30 // degrees of hue kept clear on both sides of the accent
const LABEL_SATURATIONS = [0.85, 0.7]
const LABEL_LIGHTNESSES = [0.8, 0.72, 0.86]

// The hue of #rrggbb, 0-360; null for a grey.
function hueOf(color: string): number | null {
  const [red = 0, green = 0, blue = 0] = [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16) / 255)
  const most = Math.max(red, green, blue)
  const range = most - Math.min(red, green, blue)
  if (range < 0.05) return null
  const sector = most === red ? (green - blue) / range : most === green ? (blue - red) / range + 2 : (red - green) / range + 4
  return (sector * 60 + 360) % 360
}

// A label's own pastel in the colorful setting: the same for the same name on every device, the
// hue spread over the whole circle except next to the accent, so a chip never looks like a button.
export function labelColor(label: string, accent: string): string {
  let hash = 0x811c9dc5 // FNV-1a
  for (const char of label) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0
  const away = hueOf(accent)
  const free = away === null ? 360 : 360 - 2 * LABEL_AWAY
  const start = away === null ? 0 : away + LABEL_AWAY
  const hue = (start + ((hash % 3600) / 3600) * free) % 360
  const saturation = LABEL_SATURATIONS[(hash >>> 12) % LABEL_SATURATIONS.length] ?? 0.8
  const lightness = LABEL_LIGHTNESSES[(hash >>> 16) % LABEL_LIGHTNESSES.length] ?? 0.8
  return hslToHex(hue, saturation, lightness)
}

const HONEYCOMB_RADIUS = 3
const HONEYCOMB_CENTER = '#3f3f46'
const HONEYCOMB_SATURATION = 0.85
const HONEYCOMB_LIGHTNESS = [0, 0.72, 0.56, 0.42] // by distance from the center

// Rows of a hexagon of hexagons: hue goes around the center, the rings get deeper outwards.
export function honeycomb(): string[][] {
  const rows: string[][] = []
  for (let row = -HONEYCOMB_RADIUS; row <= HONEYCOMB_RADIUS; row++) {
    const cells: string[] = []
    const first = Math.max(-HONEYCOMB_RADIUS, -HONEYCOMB_RADIUS - row)
    const last = Math.min(HONEYCOMB_RADIUS, HONEYCOMB_RADIUS - row)
    for (let column = first; column <= last; column++) {
      const ring = Math.max(Math.abs(column), Math.abs(row), Math.abs(column + row))
      const angle = (Math.atan2((row * Math.sqrt(3)) / 2, column + row / 2) * 180) / Math.PI
      cells.push(ring ? hslToHex((angle + 360) % 360, HONEYCOMB_SATURATION, HONEYCOMB_LIGHTNESS[ring] ?? 0) : HONEYCOMB_CENTER)
    }
    rows.push(cells)
  }
  return rows
}
