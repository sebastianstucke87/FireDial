import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GoogleDrive, OfflineError, SignInError } from './drive.ts'

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

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const status = (code: number, text = ''): Response => new Response(text, { status: code })

// The multipart body for this metadata and content, with the boundary the request used.
function multipartBody(call: Call, metadata: object, content: string): string {
  const boundary = /^multipart\/related; boundary=(firedial-[\w-]+)$/.exec(call.headers['content-type'] ?? '')?.[1] ?? assert.fail('no boundary')
  const type = 'Content-Type: application/json; charset=UTF-8'
  return [`--${boundary}`, type, '', JSON.stringify(metadata), `--${boundary}`, type, '', content, `--${boundary}--`, ''].join('\r\n')
}

test('every request carries the sign-in; a refused one is tried once more with a fresh one', async () => {
  const { fetcher, call, count } = google([status(401), json({ user: { emailAddress: 'me@example.com' } })])
  assert.equal(await new GoogleDrive(auth, fetcher).email(), 'me@example.com')
  assert.equal(call(0).url, `${API}/about?fields=user(emailAddress)`)
  assert.equal(call(0).headers['authorization'], 'Bearer t')
  assert.equal(call(1).headers['authorization'], 'Bearer t2')
  assert.equal(count(), 2)
  const refused = google([status(401), status(401)])
  await assert.rejects(new GoogleDrive(auth, refused.fetcher).email(), (error) => error instanceof SignInError && error.message === 'Google sign-in ran out')
})

test('busy, down or too many: offline for now; anything else is an error', async () => {
  const fails = async (answer: Response): Promise<unknown> => {
    try {
      await new GoogleDrive(auth, google([answer]).fetcher).read('a')
    } catch (error) {
      return error
    }
    return assert.fail('no error')
  }
  for (const code of [429, 500, 503]) {
    const error = await fails(status(code))
    assert.ok(error instanceof OfflineError)
    assert.equal(error.message, `Google Drive: ${code}`)
  }
  assert.ok((await fails(status(403, '{"reason": "rateLimitExceeded"}'))) instanceof OfflineError)
  for (const code of [403, 404, 499]) {
    const error = await fails(status(code, 'nope'))
    assert.ok(error instanceof Error && !(error instanceof OfflineError))
    assert.equal(error.message, `Google Drive: ${code} nope`)
  }
})

test('no connection at all is offline', async () => {
  const cause = new TypeError('NetworkError')
  const drive = new GoogleDrive(auth, () => Promise.reject(cause))
  await assert.rejects(drive.read('a'), (error) => error instanceof OfflineError && error.message === 'No connection to Google Drive' && error.cause === cause)
})

test('without a fetch of its own, it uses the browser one', async (t) => {
  const calls: unknown[] = []
  t.mock.method(globalThis, 'fetch', (input: unknown) => {
    calls.push(input)
    return Promise.resolve(new Response('content', { status: 200 }))
  })
  assert.equal(await new GoogleDrive(auth).read('a'), 'content')
  assert.deepEqual(calls, [`${API}/files/a?alt=media`])
})

test('the list goes page by page, only the app folder', async () => {
  const { fetcher, call, count } = google([
    json({ files: [{ id: 'a', name: 'state.json', appProperties: { version: '3' } }, { id: 'b' }], nextPageToken: 'p2' }),
    json({ files: [{ id: 'c', name: 'thumb-1', appProperties: 'bad' }] })
  ])
  assert.deepEqual(await new GoogleDrive(auth, fetcher).list(), [
    { id: 'a', name: 'state.json', props: { version: '3' } },
    { id: 'b', name: '', props: {} },
    { id: 'c', name: 'thumb-1', props: {} }
  ])
  assert.equal(count(), 2)
  const first = new URL(call(0).url)
  assert.equal(`${first.origin}${first.pathname}`, `${API}/files`)
  assert.deepEqual(Object.fromEntries(first.searchParams), {
    spaces: 'appDataFolder',
    pageSize: '1000',
    fields: 'nextPageToken,files(id,name,appProperties)'
  })
  assert.equal(new URL(call(1).url).searchParams.get('pageToken'), 'p2')
  const empty = google([json({})])
  assert.deepEqual(await new GoogleDrive(auth, empty.fetcher).list(), [])
  assert.equal(empty.count(), 1)
})

test('read gets the content of a file', async () => {
  const { fetcher, call } = google([status(200, 'hello')])
  assert.equal(await new GoogleDrive(auth, fetcher).read('a/b'), 'hello')
  assert.equal(call(0).url, `${API}/files/a%2Fb?alt=media`)
  assert.equal(call(0).method, 'GET')
})

test('create sends name, place and properties with the content in one request', async () => {
  const { fetcher, call } = google([json({ id: 'n1', name: 'state.json', appProperties: { version: '1' } })])
  const file = await new GoogleDrive(auth, fetcher).create('state.json', '{"a":1}', { version: '1' })
  assert.deepEqual(file, { id: 'n1', name: 'state.json', props: { version: '1' } })
  assert.equal(call(0).method, 'POST')
  assert.equal(call(0).url, `${UPLOAD}/files?uploadType=multipart&fields=id,name,appProperties`)
  assert.equal(call(0).body, multipartBody(call(0), { name: 'state.json', parents: ['appDataFolder'], appProperties: { version: '1' } }, '{"a":1}'))
  const bare = google([json({ id: 'n2', name: 'x' })])
  await new GoogleDrive(auth, bare.fetcher).create('x', 'y')
  assert.equal(bare.call(0).body, multipartBody(bare.call(0), { name: 'x', parents: ['appDataFolder'], appProperties: {} }, 'y'))
})

test('update replaces content and properties', async () => {
  const { fetcher, call } = google([json({ id: 'a/b' }), json({ id: 'c' })])
  const drive = new GoogleDrive(auth, fetcher)
  await drive.update('a/b', 'new', { version: '2' })
  assert.equal(call(0).method, 'PATCH')
  assert.equal(call(0).url, `${UPLOAD}/files/a%2Fb?uploadType=multipart&fields=id`)
  assert.equal(call(0).body, multipartBody(call(0), { appProperties: { version: '2' } }, 'new'))
  await drive.update('c', 'x')
  assert.equal(call(1).body, multipartBody(call(1), { appProperties: {} }, 'x'))
})

// A batch answer: one part per delete, each with its status. A status inside a line isn't one.
const batch = (statuses: number[]): Response =>
  new Response(statuses.map((code) => `--b\r\nContent-Type: application/http\r\nX-Note: HTTP/1.1 500 X\r\n\r\nHTTP/1.1 ${code} X\r\n\r\n`).join('') + '--b--', {
    status: 200
  })

test('a batch request: one delete per file, a hundred at most', async () => {
  const ids = Array.from({ length: 150 }, (_, index) => `id${index}`)
  const { fetcher, call, count } = google([batch(Array<number>(100).fill(204)), batch(Array<number>(50).fill(204))])
  const progress: number[] = []
  await new GoogleDrive(auth, fetcher).remove(ids, (done) => {
    progress.push(done)
    return Promise.resolve()
  })
  assert.equal(count(), 2)
  assert.deepEqual(progress, [100, 150])
  assert.equal(call(0).method, 'POST')
  assert.equal(call(0).url, 'https://www.googleapis.com/batch/drive/v3')
  const boundary = /^multipart\/mixed; boundary=(firedial-[\w-]+)$/.exec(call(0).headers['content-type'] ?? '')?.[1] ?? assert.fail('no boundary')
  const part = (id: string, index: number): string =>
    [`--${boundary}`, 'Content-Type: application/http', `Content-ID: <${index}>`, '', `DELETE /drive/v3/files/${id}`, ''].join('\r\n')
  assert.equal(call(0).body, `${ids.slice(0, 100).map(part).join('')}--${boundary}--\r\n`)
  assert.equal(String(call(1).body).match(/DELETE/g)?.length, 50)
  const none = google([])
  await new GoogleDrive(auth, none.fetcher).remove([])
  assert.equal(none.count(), 0)
})

test('a batch with a refused sign-in is sent again with a fresh one', async () => {
  let renewed = 0
  const renewing = {
    token: () => Promise.resolve('t'),
    renew: () => {
      renewed += 1
      return Promise.resolve('t2')
    }
  }
  const { fetcher, count } = google([batch([204, 401]), batch([204, 204])])
  await new GoogleDrive(renewing, fetcher).remove(['a', 'b'])
  assert.equal(renewed, 1)
  assert.equal(count(), 2)
  const refused = google([batch([401]), batch([401])])
  await assert.rejects(
    new GoogleDrive(auth, refused.fetcher).remove(['a']),
    (error) => error instanceof SignInError && error.message === 'Google sign-in ran out'
  )
})

test('a busy batch is offline; a failed delete an error; one gone already is fine', async () => {
  const busy = (error: unknown): boolean => error instanceof OfflineError && error.message === 'Google Drive: busy'
  for (const code of [429, 500]) await assert.rejects(new GoogleDrive(auth, google([batch([204, code])]).fetcher).remove(['a', 'b']), busy)
  const failed = (code: number) => (error: unknown) =>
    !(error instanceof OfflineError) && error instanceof Error && error.message === `Google Drive: ${code} deleting files`
  await assert.rejects(new GoogleDrive(auth, google([batch([300])]).fetcher).remove(['a']), failed(300))
  await assert.rejects(new GoogleDrive(auth, google([batch([204, 499])]).fetcher).remove(['a', 'b']), failed(499))
  await new GoogleDrive(auth, google([batch([200, 299, 404])]).fetcher).remove(['a', 'b', 'c'])
})

test('the folder is looked for in the user’s own Drive and made there', async () => {
  const { fetcher, call } = google([json({ files: [] }), json({ id: 'f2', name: 'FireDial' })])
  await new GoogleDrive(auth, fetcher).folder('FireDial')
  const query = new URL(call(0).url)
  assert.equal(`${query.origin}${query.pathname}`, `${API}/files`)
  assert.equal(query.searchParams.get('spaces'), 'drive')
  assert.equal(query.searchParams.get('fields'), 'files(id,name)')
  assert.equal(call(1).url, `${API}/files?fields=id,name`)
  assert.equal(call(1).headers['content-type'], 'application/json')
})

test('an upload goes to the resumable address; no address is an error', async () => {
  const start = new Response('', { status: 200, headers: { Location: 'https://upload.example/session' } })
  const { fetcher, call } = google([start, json({ id: 'x' })])
  await new GoogleDrive(auth, fetcher).upload('backup.json', new Blob(['{}'], { type: 'application/json' }), 'f1')
  assert.equal(call(0).url, `${UPLOAD}/files?uploadType=resumable`)
  assert.equal(call(0).method, 'POST')
  assert.equal(call(0).headers['content-type'], 'application/json; charset=UTF-8')
  assert.equal(call(1).headers['content-type'], 'application/json')
  const nowhere = google([json({})])
  await assert.rejects(new GoogleDrive(auth, nowhere.fetcher).upload('b', new Blob(['x']), 'f1'), { message: 'Google Drive gave no upload address' })
  assert.equal(nowhere.count(), 1)
})

test('no email from Google: none', async () => {
  for (const answer of [{}, { user: {} }, { user: 5 }]) assert.equal(await new GoogleDrive(auth, google([json(answer)]).fetcher).email(), '')
})
