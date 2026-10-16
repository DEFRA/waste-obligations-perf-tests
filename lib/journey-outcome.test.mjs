import test from 'node:test'
import assert from 'node:assert/strict'
import { finaliseCombinedJourney, summariseJourneyOutcomes } from './journey-outcome.mjs'

function journey(overrides = {}) {
  const calls = []
  return { calls, options: { failed: false,
    verifySubmitted: async () => calls.push('verify'),
    assertMembership: async expected => calls.push(`membership:${expected}`),
    complete: async outcome => { calls.push(outcome); return { status: 'Cancelled' } },
    cancel: async () => { calls.push('cleanup'); return 1 }, ...overrides } }
}

test('successful combined journey verifies submitted, absence, saved cancellation and presence', async () => {
  const { calls, options } = journey()
  assert.deepEqual(await finaliseCombinedJourney(options), { failed: false, persistedOutcomeStatus: 'Cancelled', cancelledDeclarations: 1, cleanupCancelledDeclarations: 0, error: null })
  assert.deepEqual(calls, ['verify', 'membership:false', 'cancel', 'membership:true'])
})

test('failed journey cancels any submitted declaration and verifies restoration', async () => {
  const { calls, options } = journey({ failed: true })
  const result = await finaliseCombinedJourney(options)
  assert.equal(result.failed, true)
  assert.equal(result.cancelledDeclarations, 1)
  assert.equal(result.persistedOutcomeStatus, null)
  assert.deepEqual(calls, ['cleanup', 'membership:true'])
})

test('cancellation failure also triggers cleanup and retains the failure', async () => {
  const { calls, options } = journey({ complete: async () => { throw new Error('cancel failed') } })
  const result = await finaliseCombinedJourney(options)
  assert.equal(result.error, 'cancel failed')
  assert.equal(result.failed, true)
  assert.equal(result.cancelledDeclarations, 1)
  assert.deepEqual(calls, ['verify', 'membership:false', 'cleanup', 'membership:true'])
})

test('cleanup failure remains fatal rather than reporting successful cancellation', async () => {
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


test('submission verification failure triggers recovery cancellation', async () => {
  const { calls, options } = journey({ verifySubmitted: async () => { throw new Error('submission missing') } })
  const result = await finaliseCombinedJourney(options)
  assert.equal(result.failed, true)
  assert.equal(result.error, 'submission missing')
  assert.deepEqual(calls, ['cleanup', 'membership:true'])
})

test('failed membership retains saved Cancelled evidence and records its cancellation during cleanup', async () => {
  const { calls, options } = journey()
  let checks = 0
  options.assertMembership = async expected => {
    calls.push(`membership:${expected}`)
    if (++checks === 2) throw new Error('membership failed')
  }
  const result = await finaliseCombinedJourney(options)
  assert.equal(result.failed, true)
  assert.equal(result.persistedOutcomeStatus, 'Cancelled')
  assert.equal(result.cleanupCancelledDeclarations, 1)
  assert.equal(result.cancelledDeclarations, 1)
  assert.deepEqual(calls, ['verify', 'membership:false', 'cancel', 'membership:true', 'cleanup', 'membership:true'])
})


test('saved cancellation remains in the failed result when cleanup also fails', async () => {
  let checks = 0
  const { options } = journey({
    assertMembership: async () => { if (++checks === 2) throw new Error('membership failed') },
    cancel: async () => { throw new Error('cleanup failed') }
  })
  const result = await finaliseCombinedJourney(options)
  assert.equal(result.failed, true)
  assert.equal(result.persistedOutcomeStatus, 'Cancelled')
  assert.equal(result.cleanupCancelledDeclarations, 0)
  assert.equal(result.error, 'membership failed; cleanup failed')
})

test('summary counts successful outcomes separately from failed saved transitions', () => {
  assert.deepEqual(summariseJourneyOutcomes([
    { persistedOutcomeStatus: 'Cancelled', journeyFailed: false },
    { persistedOutcomeStatus: 'Cancelled', journeyFailed: false },
    { persistedOutcomeStatus: 'Cancelled', journeyFailed: true, cleanupCancelledDeclarationCount: 1 },
    { persistedOutcomeStatus: 'Cancelled', journeyFailed: false, fatalError: 'cleanup failed' }
  ]), { cancelled: 2, savedCancelled: 4, failed: 2 })
})


test('an unexpected saved outcome cannot release an account as cancelled', async () => {
  const { options } = journey({ complete: async () => ({ status: 'Accepted' }) })
  const result = await finaliseCombinedJourney(options)
  assert.equal(result.failed, true)
  assert.equal(result.persistedOutcomeStatus, null)
  assert.match(result.error, /Expected saved Cancelled/)
})
