import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseSyncState } from '../sync.ts'
import { ago, statusText } from './sync.ts'

const NOW = 10 * 86_400_000

test('how long ago, in the largest whole unit', () => {
  assert.equal(ago(NOW - 30_000, NOW), 'just now')
  assert.equal(ago(NOW - 5 * 60_000, NOW), '5 min ago')
  assert.equal(ago(NOW - 2 * 3_600_000, NOW), '2 h ago')
  assert.equal(ago(NOW - 3 * 86_400_000, NOW), '3 d ago')
  assert.equal(ago(NOW + 60_000, NOW), 'just now') // another computer's clock ahead
})

test('the status line', () => {
  const state = parseSyncState({ on: true, status: 'ok', last: { device: 'Chrome on Windows', at: NOW - 5 * 60_000 } })
  assert.equal(statusText(state, NOW), 'Synced 5 min ago · Chrome on Windows')
  assert.equal(statusText({ ...state, status: 'offline' }, NOW), 'Offline · retrying')
  assert.equal(statusText({ ...state, status: 'signin' }, NOW), 'Paused · sign in again')
  assert.equal(statusText({ ...state, status: 'syncing' }, NOW), 'Syncing…')
})
