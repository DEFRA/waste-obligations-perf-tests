import assert from 'node:assert/strict'
import test from 'node:test'

import { loadTestUserIterations } from './load-test-session.js'

function withIterationCount(value, action) {
  const previous = process.env.LOAD_TEST_USER_ITERATIONS

  try {
    if (value === undefined) {
      delete process.env.LOAD_TEST_USER_ITERATIONS
    } else {
      process.env.LOAD_TEST_USER_ITERATIONS = value
    }
    action()
  } finally {
    if (previous === undefined) {
      delete process.env.LOAD_TEST_USER_ITERATIONS
    } else {
      process.env.LOAD_TEST_USER_ITERATIONS = previous
    }
  }
}

test('loadTestUserIterations defaults to one', () => {
  withIterationCount(undefined, () => {
    assert.equal(loadTestUserIterations(), 1)
  })
})

test('loadTestUserIterations accepts a positive whole number', () => {
  withIterationCount('3', () => {
    assert.equal(loadTestUserIterations(), 3)
  })
})

test('loadTestUserIterations rejects invalid values', () => {
  for (const value of ['0', '-1', '1.5', 'invalid']) {
    withIterationCount(value, () => {
      assert.throws(
        () => loadTestUserIterations(),
        /LOAD_TEST_USER_ITERATIONS must be a positive integer/
      )
    })
  }
})
