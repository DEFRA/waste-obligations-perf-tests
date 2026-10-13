import test from 'node:test'
import assert from 'node:assert/strict'
import { runUniqueJourneys } from './unique-journeys.mjs'

const accounts = count => Array.from({ length: count }, (_, userIndex) => ({ allocation: { organisationId: `org-${userIndex}`, userIndex } }))
const configuration = { journeyRatePerMinute: 1, measuredDurationMilliseconds: 3600000, journeyConcurrency: 4, journeyLimit: 500 }
const clock = () => {
  let time = 0
  return { now: () => time, sleep: async ms => { time += ms; await new Promise(resolve => setImmediate(resolve)) }, advance: ms => { time += ms } }
}

test('60-minute window consumes60 unique IDs once at minute slots, never returning cancelled IDs', async () => {
  const time = clock()
  const starts = []
  const result = await runUniqueJourneys(accounts(500), configuration, 0, async account => {
    starts.push({ id: account.allocation.organisationId, at: time.now() })
    return { organisationId: account.allocation.organisationId, persistedOutcomeStatus: 'Cancelled' }
  }, time)
  assert.equal(starts.length, 60)
  assert.equal(new Set(starts.map(start => start.id)).size, 60)
  assert.deepEqual(starts.map(start => start.at), Array.from({ length: 60 }, (_, index) => index * 60000))
  assert.equal(result.remainingPoolCount, 440)
  assert.equal(result.missedSlots, 0)
})

test('exhausted pool stops starts without reusing organisations while configured read window remains fixed', async () => {
  const result = await runUniqueJourneys(accounts(2), configuration, 0, async account => ({ organisationId: account.allocation.organisationId }), clock())
  assert.equal(result.uniqueOrganisationsStarted, 2)
  assert.equal(result.poolExhausted, true)
  assert.equal(result.measuredEndAtUtc, new Date(3600000).toISOString())
})

test('delayed wake skips missed slots and never catches up with a burst', async () => {
  const time = clock()
  const starts = []
  const result = await runUniqueJourneys(accounts(5), { ...configuration, measuredDurationMilliseconds: 240000 }, 0, async account => {
    starts.push(time.now())
    if (account.allocation.userIndex === 0) time.advance(125000)
    return {}
  }, time)
  assert.equal(result.missedSlots, 1)
  assert.deepEqual(starts, [0, 125000, 185000])
})

test('near-boundary delayed wake cannot launch again100ms later at the next absolute slot', async () => {
  const time = clock()
  const starts = []
  const delayed = { now: time.now, sleep: async ms => { await time.sleep(ms); if (time.now() === 60000) time.advance(59900) } }
  const result = await runUniqueJourneys(accounts(5), { ...configuration, measuredDurationMilliseconds: 240000 }, 0, async () => {
    starts.push(time.now())
    return {}
  }, delayed)
  assert.deepEqual(starts, [0, 119900, 179900, 239900])
  assert.equal(result.missedSlots, 0)
  assert.ok(starts.slice(1).every((at, index) => at - starts[index] >= 60000))
})

test('millisecond timer jitter waits for safe spacing without dropping healthy arrival slots', async () => {
  let time = 2
  let sleepCount = 0
  const starts = []
  const jitteredClock = {
    now: () => time,
    sleep: async milliseconds => {
      const jitter = [-1, 0, 2, -1, 0][sleepCount++] ?? 0
      time += milliseconds + jitter
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  const result = await runUniqueJourneys(accounts(5), { ...configuration, measuredDurationMilliseconds: 240000 }, 0, async () => {
    starts.push(time)
    return {}
  }, jitteredClock)
  assert.equal(starts.length, 4)
  assert.equal(result.missedSlots, 0)
  assert.ok(starts.slice(1).every((at, index) => at - starts[index] >= 60000))
  assert.ok(starts.every((at, index) => at < (index + 1) * 60000))
})

test('concurrency saturation records missed slots rather than launching overlapping excess', async () => {
  const time = clock()
  let release
  const resultPromise = runUniqueJourneys(accounts(5), { ...configuration, journeyConcurrency: 1, measuredDurationMilliseconds: 180000 }, 0,
    () => new Promise(resolve => { release = resolve }), time)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  release({})
  const result = await resultPromise
  assert.equal(result.uniqueOrganisationsStarted, 1)
  assert.equal(result.missedSlots, 2)
})
