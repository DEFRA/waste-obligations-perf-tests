import test from 'node:test'
import assert from 'node:assert/strict'
import { eligibleOrganisationIds, assertEquivalentAllocations, runReusableJourneys } from './reusable-journeys.mjs'
const accounts = Array.from({ length: 3 }, (_, userIndex) => ({ type: 'dp', allocation: { organisationId: `org-${userIndex}`, userIndex, userId: 'user' } }))
const allocations = accounts.map(account => account.allocation)
const config = { journeyRatePerMinute: 60, measuredDurationMilliseconds: 12000, journeyConcurrency: 2, journeyLimit: null }
const clock = () => {
  let time = 0
  return { now: () => time, sleep: async ms => { time += ms; await new Promise(resolve => setImmediate(resolve)) }, advance: ms => { time += ms } }
}
const success = () => ({ persistedOutcomeStatus: 'Cancelled', journeyFailed: false })

test('only exact original IDs in the target year are eligible, including pending metrics', () => {
  assert.deepEqual(eligibleOrganisationIds([null, {}, { organisationId: 'stale', obligationYear: 2026 },
    { organisationId: 'org-0', obligationYear: 2025 }, { organisationId: 'org-1', obligationYear: 2026, recyclingObligationsMet: null }], allocations, 2026), ['org-1'])
})
test('allocation equivalence ignores order but rejects changed session identity and type', () => {
  assert.doesNotThrow(() => assertEquivalentAllocations([...accounts].reverse(), allocations))
  for (const field of ['organisationId', 'userId', 'userIndex', 'operatorOrganisationId']) {
    assert.throws(() => assertEquivalentAllocations([{ ...accounts[0], allocation: { ...allocations[0], [field]: 'other' } }, ...accounts.slice(1)], allocations), /do not match/)
  }
  assert.throws(() => assertEquivalentAllocations([{ ...accounts[0], type: 'cso' }, ...accounts.slice(1)], allocations))
})
test('successful cycles reuse fairly and discover later original IDs without stale enrollment', async () => {
  const time = clock()
  const starts = []
  const result = await runReusableJourneys(accounts, config, 0, async account => { starts.push(account.allocation.organisationId); return success() }, {
    initialOrganisationIds: ['org-0'], read: async () => time.now() >= 5000 ? ['org-1', 'stale'] : []
  }, time)
  assert.equal(result.cyclesStarted, 12)
  assert.equal(result.uniqueOrganisationsStarted, 2)
  assert.ok(starts.slice(7).includes('org-1'))
  assert.deepEqual(result.neverSeenOrganisationIds, ['org-2'])
  assert.ok(!starts.includes('stale'))
  assert.equal(result.missedSlots, 0)
})
test('failures quarantine even after cleanup and repeated discovery', async () => {
  const time = clock()
  const result = await runReusableJourneys(accounts, config, 0, async () => ({ ...success(), journeyFailed: true }), {
    initialOrganisationIds: ['org-0'], read: async () => ['org-0']
  }, time)
  assert.equal(result.cyclesStarted, 1)
  assert.deepEqual(result.quarantinedOrganisationIds, ['org-0'])
  assert.equal(result.dataStarvedSlots, 11)
})
test('starvation continues through the window and late discovery resumes launches', async () => {
  const time = clock()
  const result = await runReusableJourneys(accounts, config, 0, async () => success(), {
    read: async () => time.now() >= 5000 ? ['org-2'] : []
  }, time)
  assert.ok(result.dataStarvedSlots >= 5)
  assert.ok(result.cyclesStarted > 0)
  assert.equal(result.measuredEndAtUtc, new Date(12000).toISOString())
})
test('a busy ID never overlaps, and concurrency saturation is separate from starvation', async () => {
  const time = clock()
  let release
  const promise = runReusableJourneys(accounts, { ...config, journeyConcurrency: 1 }, 0,
    () => new Promise(resolve => { release = resolve }), { initialOrganisationIds: ['org-0'], read: async () => ['org-0'] }, time)
  while (time.now() < 12000) await new Promise(resolve => setImmediate(resolve))
  release(success())
  const result = await promise
  assert.equal(result.cyclesStarted, 1)
  assert.equal(result.saturatedSlots, 11)
  assert.equal(result.dataStarvedSlots, 0)
})
test('late scheduling preserves spacing without catchup or launches after the deadline', async () => {
  const time = clock()
  const starts = []
  const result = await runReusableJourneys(accounts, config, 0, async () => {
    starts.push(time.now()); if (starts.length === 1) time.advance(2500); return success()
  }, { initialOrganisationIds: ['org-0', 'org-1'], read: async () => [] }, time)
  assert.ok(result.timingMissedSlots > 0)
  assert.ok(starts.slice(1).every((at, index) => at - starts[index] >= 1000))
  assert.ok(starts.every(at => at < 12000))
})
test('cycle cap stops arrivals while discovery remains bounded by measurement', async () => {
  const time = clock()
  const scans = []
  const result = await runReusableJourneys(accounts, { ...config, journeyLimit: 2 }, 0, async () => success(), {
    initialOrganisationIds: ['org-0'], read: async deadline => { scans.push(time.now()); assert.equal(deadline, 12000); return [] }
  }, time)
  assert.equal(result.cyclesStarted, 2)
  assert.equal(result.journeyLimitReached, true)
  assert.ok(scans.every(at => at < 12000))
  assert.equal(time.now(), 12000)
})
test('discovery failures remain visible in results', async () => {
  const result = await runReusableJourneys(accounts, config, 0, async () => success(), {
    read: async () => { throw new Error('public view failed') }
  }, clock())
  assert.equal(result.cyclesStarted, 0)
  assert.ok(result.discoveryErrors.includes('public view failed'))
})


test('same ID stays unavailable through finalization even with spare concurrency', async () => {
  const time = clock()
  let release
  const promise = runReusableJourneys(accounts, config, 0, () => new Promise(resolve => { release = resolve }),
    { initialOrganisationIds: ['org-0'], read: async () => ['org-0'] }, time)
  while (time.now() < 12000) await new Promise(resolve => setImmediate(resolve))
  release(success())
  const result = await promise
  assert.equal(result.cyclesStarted, 1)
  assert.equal(result.dataStarvedSlots, 11)
  assert.equal(result.saturatedSlots, 0)
})

test('discovery timeout caused by measurement end drains without a spurious failure', async () => {
  const time = clock()
  let finishScan
  const promise = runReusableJourneys(accounts, { ...config, measuredDurationMilliseconds: 1000 }, 0,
    async () => success(), { initialOrganisationIds: ['org-0'], read: () => new Promise((resolve, reject) => { finishScan = reject }) }, time)
  while (time.now() < 1000) await new Promise(resolve => setImmediate(resolve))
  finishScan(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
  const result = await promise
  assert.deepEqual(result.discoveryErrors, [])
  assert.equal(result.cyclesStarted, 1)
})

test('near-boundary timer jitter never creates a catchup burst', async () => {
  const time = clock()
  let delayed = false
  const jitter = { now: time.now, sleep: async ms => {
    await time.sleep(ms)
    if (!delayed && time.now() >= 1000) { delayed = true; time.advance(999) }
  } }
  const starts = []
  const result = await runReusableJourneys(accounts, config, 0, async () => { starts.push(time.now()); return success() },
    { initialOrganisationIds: ['org-0', 'org-1'], read: async () => [] }, jitter)
  assert.ok(starts.slice(1).every((at, index) => at - starts[index] >= 1000))
  assert.ok(starts.every(at => at < 12000))
  assert.equal(result.timingMissedSlots, 0)
})
