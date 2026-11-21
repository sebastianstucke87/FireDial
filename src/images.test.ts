import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blobToDataUrl, faviconPath, isStoredImage, readImage, siteAccess } from './images.ts'
import { LimitError } from './model.ts'

test('only data URLs count as stored images', () => {
  assert.equal(isStoredImage('data:image/png;base64,AAAA'), true)
  assert.equal(isStoredImage('https://example.com/favicon.ico'), false)
  assert.equal(isStoredImage('http://example.com/a.png'), false)
  assert.equal(isStoredImage(''), false)
  assert.equal(isStoredImage('data:image/svg+xml,<svg/>'), true)
  assert.equal(isStoredImage('DATA:IMAGE/JPEG;base64,AAAA'), true)
  assert.equal(isStoredImage('data:text/html,<script>alert(1)</script>'), false)
  assert.equal(isStoredImage('data:,image/png'), false)
  assert.equal(isStoredImage('data:image/'), false)
  assert.equal(isStoredImage('javascript:alert(1)'), false)
})

test('a blob becomes a data URL of its type and bytes', async () => {
  const url = await blobToDataUrl(new Blob([new Uint8Array([0, 1, 254, 255])], { type: 'image/png' }))
  assert.equal(url, 'data:image/png;base64,AAH+/w==')
})

test('a blob larger than one chunk keeps every byte', async () => {
  const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, index) => index % 256)
  const url = await blobToDataUrl(new Blob([bytes], { type: 'image/webp' }))
  // Compared as text: a failing deepEqual of 65k bytes builds a diff that takes gigabytes.
  assert.equal(url, `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`)
})

test('a blob without a type is still a data URL', async () => {
  assert.equal(await blobToDataUrl(new Blob([new Uint8Array([65])])), 'data:application/octet-stream;base64,QQ==')
})

test('the favicon path carries the page, escaped', () => {
  assert.equal(faviconPath('https://a.example/x?y=1&z', 64), '/_favicon/?pageUrl=https%3A%2F%2Fa.example%2Fx%3Fy%3D1%26z&size=64')
})

test('site access covers each whole site', () => {
  assert.deepEqual(siteAccess(['https://a.example', 'http://b.example']), { origins: ['https://a.example/*', 'http://b.example/*'] })
})

// A response streamed in parts, counting what was read before it stopped.
function streamed(parts: number[], headers: Record<string, string> = {}): { response: Response; pulled: () => number } {
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = parts[pulled++]
      if (size === undefined) controller.close()
      else controller.enqueue(new Uint8Array(size).fill(7))
    }
  })
  return { response: new Response(body, { headers }), pulled: () => pulled }
}

test('an image from a link is read whole, with its type', async () => {
  const { response } = streamed([3, 4], { 'Content-Type': 'image/png; charset=binary' })
  const blob = await readImage(response, 7)
  assert.equal(blob.size, 7)
  assert.equal(blob.type, 'image/png')
})

test('an image larger than the limit stops loading there', async () => {
  const { response, pulled } = streamed([4, 4, 4, 4, 4])
  await assert.rejects(readImage(response, 7), (error) => error instanceof LimitError && error.message === "Previews can't be over 0 MB")
  assert.ok(pulled() <= 3, `read ${pulled()} parts`)
})

test('an image that says it is too large is not read at all', async () => {
  const { response, pulled } = streamed([1], { 'Content-Length': '8' })
  await assert.rejects(readImage(response, 7), LimitError)
  assert.equal(pulled(), 0)
})

test('the limit is 20 MB unless told otherwise', async () => {
  await assert.rejects(readImage(new Response(null, { headers: { 'Content-Length': String(20 * 1024 ** 2 + 1) } })), /over 20 MB/)
  assert.equal((await readImage(new Response(new Uint8Array(3)))).size, 3)
})
