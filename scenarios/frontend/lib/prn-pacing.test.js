import assert from 'node:assert/strict'
import test from 'node:test'

import {
  iterationPacingMilliseconds,
  spreadThinkTime,
  staggeredStartMilliseconds,
  thinkTimeMilliseconds,
  waitBeforeIteration
} from './prn-pacing.js'

function withEnvironment(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    callback()
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test('pacing and think time default to zero', () => {
  withEnvironment({ LOAD_TEST_PRN_ITERATION_PACING_MS: undefined, LOAD_TEST_PRN_THINK_TIME_MS: undefined }, () => {
    assert.equal(iterationPacingMilliseconds(), 0)
    assert.equal(thinkTimeMilliseconds(), 0)
  })
})

test('pacing and think time accept milliseconds', () => {
  withEnvironment({ LOAD_TEST_PRN_ITERATION_PACING_MS: '60000', LOAD_TEST_PRN_THINK_TIME_MS: '1000' }, () => {
    assert.equal(iterationPacingMilliseconds(), 60_000)
    assert.equal(thinkTimeMilliseconds(), 1_000)
  })
})

test('pacing and think time reject invalid values', () => {
  for (const value of ['-1', '1.5', 'a minute', '3600001']) {
    withEnvironment({ LOAD_TEST_PRN_ITERATION_PACING_MS: value, LOAD_TEST_PRN_THINK_TIME_MS: value }, () => {
      assert.throws(iterationPacingMilliseconds, /LOAD_TEST_PRN_ITERATION_PACING_MS must be an integer between 0 and 3600000/)
      assert.throws(thinkTimeMilliseconds, /LOAD_TEST_PRN_THINK_TIME_MS must be an integer between 0 and 3600000/)
    })
  }
})

test('the first iteration and unpaced iterations start straight away', () => {
  assert.equal(waitBeforeIteration({ iteration: 1, userStartedAt: 0, pacingMilliseconds: 60_000, now: 0 }), 0)
  assert.equal(waitBeforeIteration({ iteration: 5, userStartedAt: 0, pacingMilliseconds: 0, now: 1_000 }), 0)
})

test('a paced iteration waits for its slot from the user start', () => {
  // Iteration 3's slot is 120 s after the start; iteration 2 finished at 95 s.
  assert.equal(waitBeforeIteration({ iteration: 3, userStartedAt: 10_000, pacingMilliseconds: 60_000, now: 105_000 }), 25_000)
})

test('an iteration whose slot has passed starts straight away', () => {
  assert.equal(waitBeforeIteration({ iteration: 2, userStartedAt: 0, pacingMilliseconds: 60_000, now: 70_000 }), 0)
})

test('think time is spread from half to one and a half times the base', () => {
  assert.equal(spreadThinkTime(0), 0)
  assert.equal(spreadThinkTime(1_000, (min) => min), 500)
  assert.equal(spreadThinkTime(1_000, (_min, max) => max - 1), 1_500)
  for (let n = 0; n < 200; n++) {
    const value = spreadThinkTime(1_000)
    assert.ok(value >= 500 && value <= 1_500, `${value} is outside 500-1500`)
  }
})

test('paced users start evenly over one interval', () => {
  const offsets = Array.from({ length: 40 }, (_, position) =>
    staggeredStartMilliseconds({ position, userCount: 40, pacingMilliseconds: 60_000 })
  )
  assert.equal(offsets[0], 0)
  assert.equal(offsets[1], 1_500)
  assert.equal(offsets[39], 58_500)
})

test('unpaced users are not staggered', () => {
  assert.equal(staggeredStartMilliseconds({ position: 5, userCount: 40, pacingMilliseconds: 0 }), 0)
})
