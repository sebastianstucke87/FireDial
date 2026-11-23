// The upscaling of small icons, in a worker of its own: the new tab never waits for it.
// Asked { id, pixels } (an icon's ImageData), it answers { id, blob } (a PNG), or { id, blob: null }
// when it can't. Pixels, not an address: the worker loads nothing.

import { upscale } from './upscale.ts'

async function upscaled(pixels: ImageData): Promise<Blob | null> {
  const big = upscale(pixels)
  const canvas = new OffscreenCanvas(big.width, big.height)
  canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(big.data), big.width, big.height), 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}

addEventListener('message', (event: MessageEvent<unknown>) => {
  // Only FireDial's own page: a dedicated worker's messages come from the page that made it.
  if (event.origin && event.origin !== location.origin) return
  const { data } = event
  if (typeof data !== 'object' || data === null || !('id' in data) || !('pixels' in data) || !(data.pixels instanceof ImageData)) return
  const { id, pixels } = data
  void upscaled(pixels)
    .catch(() => null)
    .then((blob) => {
      postMessage({ id, blob })
    })
})
