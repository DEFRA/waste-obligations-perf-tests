import test from 'node:test'
import assert from 'node:assert/strict'
import { effectivePollingTiming } from './polling-timing.mjs'

const runtime = { eligibilityRefreshPollingEnabled: true, organisationPollIntervalSeconds: 300,
  obligationPollingEnabled: true, obligationRefreshIntervalSeconds: 1800, maximumSummaryStalenessSeconds: 3600,
  maxDownstreamRequestsPerMinute: 180, obligationPollIntervalSeconds: 60, currentObligationYear: 2026 }

test('perf-specific five-minute discovery retains two refresh cycles and a 60-minute measured window', () => {
  const timing = effectivePollingTiming(runtime, 500)
  assert.equal(timing.measuredDurationMilliseconds, 3600000)
  assert.equal(timing.readinessTimeoutMilliseconds, 4127000)
  assert.equal(timing.journeyRatePerMinute, 1)
  assert.equal(timing.journeyLimit, null)
})

test('faster discovery and refresh keep 60-minute staleness window and independent traffic levers', () => {
  const timing = effectivePollingTiming({ ...runtime, organisationPollIntervalSeconds: 300, obligationRefreshIntervalSeconds: 300 }, 750)
  assert.equal(timing.windowSeconds, 300)
  assert.equal(timing.measuredDurationMilliseconds, 3600000)
  assert.equal(timing.capacityLowerBoundSeconds, 250)
  assert.equal(timing.journeyLimit, null)
})

test('capacity extends effective duration when pool cannot hydrate within a service window', () => {
  const timing = effectivePollingTiming({ ...runtime, maxDownstreamRequestsPerMinute: 20 }, 2000)
  assert.equal(timing.windowSeconds, 6000)
  assert.equal(timing.measuredDurationMilliseconds, 12000000)
})

test('disabled, malformed and mismatched runtime configuration fail before initialising', () => {
  assert.throws(() => effectivePollingTiming({ ...runtime, obligationPollingEnabled: false }, 500), /SERVICE/)
  assert.throws(() => effectivePollingTiming({ ...runtime, organisationPollIntervalSeconds: 0 }, 500), /Invalid runtime/)
  assert.throws(() => effectivePollingTiming(runtime, 500, { LOAD_TEST_STALENESS_SECONDS: '300' }), /does not match/)
  assert.throws(() => effectivePollingTiming(runtime, 500, { LOAD_TEST_EXPECTED_ORGANISATION_POLL_INTERVAL_SECONDS: '1800' }), /does not match/)
})

test('only a short measured duration requires the explicit smoke override; readiness accepts shorter positive bounds', () => {
  assert.throws(() => effectivePollingTiming(runtime, 500, { LOAD_TEST_POLL_DURATION: '1m' }), /SHORT_SMOKE/)
  assert.equal(effectivePollingTiming(runtime, 500, { LOAD_TEST_READINESS_TIMEOUT_MS: '900000' }).readinessTimeoutMilliseconds, 900000)
  assert.throws(() => effectivePollingTiming(runtime, 500, { LOAD_TEST_READINESS_TIMEOUT_MS: '0' }), /integer/)
  assert.throws(() => effectivePollingTiming(runtime, 500, { LOAD_TEST_READINESS_TIMEOUT_MS: '86400001' }), /integer/)
  const timing = effectivePollingTiming(runtime, 500, { LOAD_TEST_POLL_DURATION: '1m', LOAD_TEST_READINESS_TIMEOUT_MS: '10000', LOAD_TEST_ALLOW_SHORT_SMOKE: 'true' })
  assert.equal(timing.measuredDurationMilliseconds, 60000)
  assert.equal(timing.readinessTimeoutMilliseconds, 10000)
})

test('cycle cap is optional, may exceed pool size, and supports the legacy alias', () => {
  assert.equal(effectivePollingTiming(runtime, 500).journeyLimit, null)
  assert.equal(effectivePollingTiming(runtime, 2, { LOAD_TEST_JOURNEY_LIMIT: '100' }).journeyLimit, 100)
  assert.equal(effectivePollingTiming(runtime, 2, { LOAD_TEST_BROWSER_SAMPLE_COUNT: '10' }).journeyLimit, 10)
  assert.equal(effectivePollingTiming(runtime, 2, { LOAD_TEST_ACCEPT_PERCENTAGE: '100' }).acceptPercentage, undefined)
})

test('staleness extends a shorter schedule window without requiring two staleness windows', () => {
  assert.equal(effectivePollingTiming({ ...runtime, organisationPollIntervalSeconds: 300, obligationRefreshIntervalSeconds: 300 }, 500).requiredDurationMilliseconds, 3600000)
  assert.equal(effectivePollingTiming({ ...runtime, maximumSummaryStalenessSeconds: 5400 }, 500).requiredDurationMilliseconds, 5400000)
})


test('production thirty-minute discovery keeps its independent schedule and derived readiness budget', () => {
  const timing = effectivePollingTiming({ ...runtime, organisationPollIntervalSeconds: 1800 }, 500)
  assert.equal(timing.runtime.organisationPollIntervalSeconds, 1800)
  assert.equal(timing.readinessTimeoutMilliseconds, 5627000)
  assert.equal(timing.measuredDurationMilliseconds, 3600000)
})
