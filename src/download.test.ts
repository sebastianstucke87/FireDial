import assert from 'node:assert/strict'
import { test } from 'node:test'

import { saveFile } from './download.ts'
import type { DownloadApi } from './download.ts'

type Listener = Parameters<DownloadApi['onChanged']['addListener']>[0]

// A download that ends the given way: before the listener hears about it, or with an event.
function fakeApi(end: { state: string; error?: string }, late: boolean): { api: DownloadApi; asked: unknown[]; listeners: Set<Listener> } {
  const asked: unknown[] = []
  const listeners = new Set<Listener>()
  let state = 'in_progress'
  const finish = (): void => {
    state = end.state
    for (const listener of listeners) {
      listener({ id: 7, state: { current: end.state }, ...(end.error === undefined ? {} : { error: { current: end.error } }) })
    }
  }
  const api: DownloadApi = {
    download: (options) => {
      asked.push(options)
      if (!late) state = end.state
      return Promise.resolve(7)
    },
    search: () => {
      if (late) setTimeout(finish, 0)
      return Promise.resolve([{ state, error: state === 'interrupted' ? end.error : undefined }])
    },
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener)
    }
  }
  return { api, asked, listeners }
}

test('resolves once the file is finished', async () => {
  const { api, listeners } = fakeApi({ state: 'complete' }, true)
  await saveFile(api, 'blob:x', 'saved.json', false)
  assert.equal(listeners.size, 0)
})

test('a download that is over before anyone listens still counts', async () => {
  const { api, listeners } = fakeApi({ state: 'complete' }, false)
  await saveFile(api, 'blob:x', 'saved.json', false)
  assert.equal(listeners.size, 0)
})

test('an interrupted download fails, however it is found out', async () => {
  for (const late of [true, false]) {
    const { api, listeners } = fakeApi({ state: 'interrupted', error: 'FILE_NO_SPACE' }, late)
    await assert.rejects(saveFile(api, 'blob:x', 'saved.json', false), /FILE_NO_SPACE/)
    assert.equal(listeners.size, 0)
  }
})

test('a silent save never asks where to save; another follows Firefox', async () => {
  const silent = fakeApi({ state: 'complete' }, false)
  await saveFile(silent.api, 'blob:x', 'saved.json', true)
  assert.deepEqual(silent.asked, [{ url: 'blob:x', filename: 'saved.json', conflictAction: 'uniquify', saveAs: false }])
  const normal = fakeApi({ state: 'complete' }, false)
  await saveFile(normal.api, 'blob:x', 'saved.json', false)
  assert.deepEqual(normal.asked, [{ url: 'blob:x', filename: 'saved.json', conflictAction: 'uniquify' }])
})

test('only its own download counts, and events or searches without a state are waited out', async () => {
  const listeners = new Set<Listener>()
  const searched: unknown[] = []
  const api: DownloadApi = {
    download: () => Promise.resolve(7),
    search: (query) => {
      searched.push(query)
      setTimeout(() => {
        for (const listener of listeners) {
          listener({ id: 8, state: { current: 'interrupted' } })
          listener({ id: 7 })
          listener({ id: 7, state: { current: 'complete' } })
        }
      }, 0)
      return Promise.resolve([])
    },
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener)
    }
  }
  await saveFile(api, 'blob:x', 'saved.json', false)
  assert.deepEqual(searched, [{ id: 7 }])
})

test('a download that fails without saying why still says it failed', async () => {
  const { api } = fakeApi({ state: 'interrupted' }, true)
  await assert.rejects(saveFile(api, 'blob:x', 'saved.json', false), /The download failed/)
})
