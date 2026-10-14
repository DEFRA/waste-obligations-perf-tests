import test from 'node:test'
import assert from 'node:assert/strict'
import { finaliseCombinedJourney } from './journey-outcome.mjs'

function journey(overrides = {}) {
  const calls = []
  return { calls, options: { failed: false, outcome: 'accept',
    verifySubmitted: async () => calls.push('verify'),
    assertMembership: async expected => calls.push(`membership:${expected}`),
    complete: async outcome => { calls.push(outcome); return { status: outcome === 'accept' ? 'Accepted' : 'Cancelled' } },
    cancel: async () => { calls.push('cleanup'); return 1 }, ...overrides } }
}

test('successful accept remains Accepted with no cancellation', async () => {
  const { calls, options } = journey()
  assert.deepEqual(await finaliseCombinedJourney(options), { failed: false, persistedOutcomeStatus: 'Accepted', cancelledDeclarations: 0, error: null })
  assert.deepEqual(calls, ['verify', 'membership:false', 'accept', 'membership:false'])
})

test('failed accept journey cancels any submitted declaration and verifies restoration', async () => {
  const { calls, options } = journey({ failed: true })
  const result = await finaliseCombinedJourney(options)
  assert.equal(result.failed, true)
  assert.equal(result.cancelledDeclarations, 1)
  assert.equal(result.persistedOutcomeStatus, null)
  assert.deepEqual(calls, ['cleanup', 'membership:true'])
})

test('acceptance failure also triggers cleanup and retains the failure', async () => {
  const { calls, options } = journey({ complete: async () => { throw new Error('accept failed') } })
  const result = await finaliseCombinedJourney(options)
  assert.equal(result.error, 'accept failed')
  assert.equal(result.failed, true)
  assert.equal(result.cancelledDeclarations, 1)
  assert.deepEqual(calls, ['verify', 'membership:false', 'cleanup', 'membership:true'])
})

test('cleanup failure remains fatal rather than reporting successful acceptance', async () => {
  const { options } = journey({ failed: true, cancel: async () => { throw new Error('cleanup failed') } })
  assert.equal((await finaliseCombinedJourney(options)).error, 'cleanup failed')
})

test('successful cancel persists Cancelled and restores membership', async () => {
  const { calls, options } = journey({ outcome: 'cancel' })
  const result = await finaliseCombinedJourney(options)
  assert.equal(result.persistedOutcomeStatus, 'Cancelled')
  assert.equal(result.cancelledDeclarations, 1)
  assert.deepEqual(calls, ['verify', 'membership:false', 'cancel', 'membership:true'])
})


test('submission verification failure cancels rather than accepting the failed journey', async () => {
  const { calls, options } = journey({ verifySubmitted: async () => { throw new Error('submission missing') } })
  const result = await finaliseCombinedJourney(options)
  assert.equal(result.failed, true)
  assert.equal(result.error, 'submission missing')
  assert.deepEqual(calls, ['cleanup', 'membership:true'])
})

test('failed membership after acceptance cleans up and does not report Accepted', async () => {
  const { calls, options } = journey()
  let checks = 0
  options.assertMembership = async expected => {
    calls.push(`membership:${expected}`)
    if (++checks === 2) throw new Error('membership failed')
  }
  const result = await finaliseCombinedJourney(options)
  assert.equal(result.failed, true)
  assert.equal(result.persistedOutcomeStatus, null)
  assert.equal(result.cancelledDeclarations, 1)
  assert.deepEqual(calls, ['verify', 'membership:false', 'accept', 'membership:false', 'cleanup', 'membership:true'])
})
