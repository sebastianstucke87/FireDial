import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blobToDataUrl, faviconPath, isStoredImage, siteAccess } from './images.ts'

test('only data URLs count as stored images', () => {
  assert.equal(isStoredImage('data:image/png;base64,AAAA'), true)
  assert.equal(isStoredImage('https://example.com/favicon.ico'), false)
  assert.equal(isStoredImage('http://example.com/a.png'), false)
  assert.equal(isStoredImage(''), false)
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
