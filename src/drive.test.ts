import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GoogleDrive } from './drive.ts'

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

// Google, as far as these calls go: answers in order, and what was asked.
function google(answers: Response[]): { fetcher: typeof fetch; call: (index: number) => Call; count: () => number } {
  const calls: Call[] = []
  const fetcher: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ method: init?.method ?? 'GET', url, headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body })
    return Promise.resolve(answers.shift() ?? new Response('', { status: 500 }))
  }
  return { fetcher, call: (index) => calls[index] ?? assert.fail(`no request ${index}`), count: () => calls.length }
}

const auth = { token: () => Promise.resolve('t'), renew: () => Promise.resolve('t2') }
const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 })

test('the FireDial folder: the one there, else a new one', async () => {
  const { fetcher, call } = google([json({ files: [{ id: 'f1', name: 'FireDial' }] }), json({ files: [] }), json({ id: 'f2', name: 'FireDial' })])
  const drive = new GoogleDrive(auth, fetcher)
  assert.equal(await drive.folder('FireDial'), 'f1')
  assert.equal(await drive.folder('FireDial'), 'f2')
  assert.equal(new URL(call(0).url).searchParams.get('q'), "name = 'FireDial' and mimeType = 'application/vnd.google-apps.folder' and trashed = false")
  assert.equal(call(2).method, 'POST')
  assert.deepEqual(JSON.parse(String(call(2).body)), { name: 'FireDial', mimeType: 'application/vnd.google-apps.folder' })
})

test('an upload asks for an address, then sends the content there', async () => {
  const start = new Response('', { status: 200, headers: { Location: 'https://upload.example/session' } })
  const { fetcher, call } = google([start, json({ id: 'x' })])
  const content = new Blob(['{}'], { type: 'application/json' })
  await new GoogleDrive(auth, fetcher).upload('backup.json', content, 'f1')
  assert.deepEqual(JSON.parse(String(call(0).body)), { name: 'backup.json', parents: ['f1'] })
  assert.equal(call(0).headers['x-upload-content-type'], 'application/json')
  assert.equal(call(1).url, 'https://upload.example/session')
  assert.equal(call(1).method, 'PUT')
  assert.equal(call(1).body, content)
})

test('deletes go in batches, each answered on its own', async () => {
  const answer = (statuses: number[]): Response =>
    new Response(statuses.map((status) => `--b\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 ${status} X\r\n\r\n`).join('') + '--b--', { status: 200 })
  const { fetcher, call, count } = google([answer([204, 404])])
  await new GoogleDrive(auth, fetcher).remove(['a', 'b'])
  assert.equal(count(), 1)
  assert.match(String(call(0).body), /DELETE \/drive\/v3\/files\/a\r\n[\s\S]*DELETE \/drive\/v3\/files\/b\r\n/)
  const failing = google([answer([204, 403])])
  await assert.rejects(new GoogleDrive(auth, failing.fetcher).remove(['a', 'b']), /403/)
})
