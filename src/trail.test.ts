import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sameItems, SelectionTrail } from './trail.ts'

test('undo walks back through the selections, redo forward again', () => {
  const trail = new SelectionTrail<number[]>(sameItems)
  trail.record([], [1])
  trail.record([1], [1, 2])
  assert.deepEqual(trail.undo([1, 2]), [1])
  assert.deepEqual(trail.undo([1]), [])
  assert.equal(trail.undo([]), null)
  assert.deepEqual(trail.redo([]), [1])
  assert.deepEqual(trail.redo([1]), [1, 2])
  assert.equal(trail.redo([1, 2]), null)
})

test("what didn't change the selection is no step", () => {
  const trail = new SelectionTrail<number[]>(sameItems)
  trail.record([1, 2], [2, 1])
  trail.record([], [])
  assert.equal(trail.canUndo, false)
})

test('a new selection ends redo, and clear ends everything', () => {
  const trail = new SelectionTrail<number[]>(sameItems)
  trail.record([], [1])
  trail.undo([1])
  assert.equal(trail.canRedo, true)
  trail.record([], [2])
  assert.equal(trail.canRedo, false)
  trail.clear()
  assert.equal(trail.canUndo, false)
})

test('the same items means the same members and as many of them', () => {
  assert.equal(sameItems([1, 2], [2, 1]), true)
  assert.equal(sameItems([1, 2], [1]), false)
  assert.equal(sameItems([1], [2]), false)
})

test('a new trail has no steps, a recorded one can be undone and redone again and again', () => {
  const trail = new SelectionTrail<number[]>(sameItems)
  assert.equal(trail.canUndo, false)
  assert.equal(trail.canRedo, false)
  trail.record([], [1])
  assert.equal(trail.canUndo, true)
  assert.deepEqual(trail.undo([1]), [])
  assert.deepEqual(trail.redo([]), [1])
  assert.deepEqual(trail.undo([1]), [])
})

test('clear also ends redo', () => {
  const trail = new SelectionTrail<number[]>(sameItems)
  trail.record([], [1])
  trail.undo([1])
  trail.clear()
  assert.equal(trail.canRedo, false)
  assert.equal(trail.redo([]), null)
})
