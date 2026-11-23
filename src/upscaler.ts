// The upscaling of small icons, in a worker of its own: the new tab never waits for it.
// Asked { id, src } (a data URL), it answers { id, blob } (a PNG), or { id, blob: null } when it can't.

import { upscale } from './upscale.ts'

async function upscaled(src: string): Promise<Blob | null> {
  const bitmap = await createImageBitmap(await (await fetch(src)).blob())
  const small = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true })
  if (!small) return null
  small.drawImage(bitmap, 0, 0)
  const big = upscale(small.getImageData(0, 0, bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(big.width, big.height)
  canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(big.data), big.width, big.height), 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}

addEventListener('message', (event: MessageEvent<unknown>) => {
  const { data } = event
  if (typeof data !== 'object' || data === null || !('id' in data) || !('src' in data) || typeof data.src !== 'string') return
  const { id, src } = data
  void upscaled(src)
    .catch(() => null)
    .then((blob) => {
      postMessage({ id, blob })
    })
})
