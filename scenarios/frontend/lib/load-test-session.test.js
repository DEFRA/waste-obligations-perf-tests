import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loadTestUserIterations,
  loadTestUserMix,
  loadTestUserStartJitterMilliseconds
} from './load-test-session.js'

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

function withStartJitter(value, action) {
  const previous = process.env.LOAD_TEST_USER_START_JITTER_MS

  try {
    if (value === undefined) {
      delete process.env.LOAD_TEST_USER_START_JITTER_MS
    } else {
      process.env.LOAD_TEST_USER_START_JITTER_MS = value
    }
    action()
  } finally {
    if (previous === undefined) {
      delete process.env.LOAD_TEST_USER_START_JITTER_MS
    } else {
      process.env.LOAD_TEST_USER_START_JITTER_MS = previous
    }
  }
}

test('loadTestUserStartJitterMilliseconds defaults to zero', () => {
  withStartJitter(undefined, () => {
    assert.equal(loadTestUserStartJitterMilliseconds(), 0)
  })
})

test('loadTestUserStartJitterMilliseconds accepts milliseconds', () => {
  withStartJitter('30000', () => {
    assert.equal(loadTestUserStartJitterMilliseconds(), 30000)
  })
})

test('loadTestUserStartJitterMilliseconds rejects invalid values', () => {
  for (const value of ['-1', '1.5', 'invalid', '2147483648']) {
    withStartJitter(value, () => {
      assert.throws(
        () => loadTestUserStartJitterMilliseconds(),
        /LOAD_TEST_USER_START_JITTER_MS must be an integer/
      )
    })
  }
})

function withEnvironment(values, action) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))

  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    action()
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test('loadTestUserMix reads the named user count and ignores the shared one', () => {
  withEnvironment(
    { LOAD_TEST_USER_COUNT: '500', LOAD_TEST_PRN_USER_COUNT: '8', LOAD_TEST_CSO_PERCENTAGE: '75' },
    () => {
      assert.deepEqual(loadTestUserMix({ countVariable: 'LOAD_TEST_PRN_USER_COUNT' }), {
        userCount: 8,
        directProducerUserCount: 2,
        complianceSchemeUserCount: 6
      })
      assert.equal(loadTestUserMix().userCount, 500)
    }
  )
})

test('loadTestUserMix defaults the named user count to 40', () => {
  withEnvironment({ LOAD_TEST_USER_COUNT: '500', LOAD_TEST_PRN_USER_COUNT: undefined }, () => {
    assert.equal(loadTestUserMix({ countVariable: 'LOAD_TEST_PRN_USER_COUNT' }).userCount, 40)
  })
})

test('loadTestUserMix names the variable it rejects', () => {
  withEnvironment({ LOAD_TEST_PRN_USER_COUNT: '0' }, () => {
    assert.throws(
      () => loadTestUserMix({ countVariable: 'LOAD_TEST_PRN_USER_COUNT' }),
      /LOAD_TEST_PRN_USER_COUNT must be a positive integer/
    )
  })
})

test('loadTestUserIterations reads the named variable and ignores the shared one', () => {
  withEnvironment({ LOAD_TEST_USER_ITERATIONS: '25', LOAD_TEST_PRN_USER_ITERATIONS: undefined }, () => {
    assert.equal(loadTestUserIterations({ variable: 'LOAD_TEST_PRN_USER_ITERATIONS' }), 1)
    assert.equal(loadTestUserIterations(), 25)
  })
  withEnvironment({ LOAD_TEST_PRN_USER_ITERATIONS: '1.5' }, () => {
    assert.throws(
      () => loadTestUserIterations({ variable: 'LOAD_TEST_PRN_USER_ITERATIONS' }),
      /LOAD_TEST_PRN_USER_ITERATIONS must be a positive integer/
    )
  })
})
