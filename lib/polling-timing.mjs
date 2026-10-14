export function integerSetting(env, name, fallback, min = 1, max = 86400) {
  const value = Number(env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

export function durationMilliseconds(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(value))
  if (!match) throw new Error('LOAD_TEST_POLL_DURATION must use ms, s, m or h (for example 60m)')
  return Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]]
}

export function effectivePollingTiming(runtime, poolSize, env = {}) {
  if (runtime?.eligibilityRefreshPollingEnabled !== true || runtime?.obligationPollingEnabled !== true) {
    throw new Error('Waste Obligations organisation discovery and obligation polling must both be enabled in the SERVICE configuration')
  }
  for (const field of ['organisationPollIntervalSeconds', 'obligationRefreshIntervalSeconds', 'maximumSummaryStalenessSeconds', 'maxDownstreamRequestsPerMinute', 'obligationPollIntervalSeconds']) {
    if (!Number.isFinite(runtime[field]) || runtime[field] <= 0) throw new Error(`Invalid runtime polling configuration: ${field}`)
  }
  if (!Number.isInteger(runtime.currentObligationYear) || runtime.currentObligationYear < 2023 || runtime.currentObligationYear > 2050) throw new Error('Invalid runtime currentObligationYear')
  for (const [name, field] of [
    ['LOAD_TEST_STALENESS_SECONDS', 'maximumSummaryStalenessSeconds'],
    ['LOAD_TEST_EXPECTED_ORGANISATION_POLL_INTERVAL_SECONDS', 'organisationPollIntervalSeconds'],
    ['LOAD_TEST_EXPECTED_OBLIGATION_REFRESH_INTERVAL_SECONDS', 'obligationRefreshIntervalSeconds']
  ]) {
    if (env[name] !== undefined && Number(env[name]) !== runtime[field]) throw new Error(`${name}=${env[name]} does not match effective SERVICE ${field}=${runtime[field]}; configure/deploy the service separately`)
  }
  const capacityLowerBoundSeconds = Math.ceil(poolSize * 60 / runtime.maxDownstreamRequestsPerMinute)
  const windowSeconds = Math.max(runtime.organisationPollIntervalSeconds, runtime.obligationRefreshIntervalSeconds, capacityLowerBoundSeconds)
  const cycles = integerSetting(env, 'LOAD_TEST_POLL_CYCLES', 2, 1, 48)
  const requiredDurationMilliseconds = Math.max(cycles * windowSeconds, runtime.maximumSummaryStalenessSeconds) * 1000
  const measuredDurationMilliseconds = env.LOAD_TEST_POLL_DURATION === undefined ? requiredDurationMilliseconds : durationMilliseconds(env.LOAD_TEST_POLL_DURATION)
  if (!Number.isSafeInteger(measuredDurationMilliseconds) || measuredDurationMilliseconds < 1 || measuredDurationMilliseconds > 86400000) throw new Error('Measured polling duration must be between 1ms and 24h; reduce the pool or increase the deployed downstream capacity')
  const shortSmoke = env.LOAD_TEST_ALLOW_SHORT_SMOKE === 'true'
  if (measuredDurationMilliseconds < requiredDurationMilliseconds && !shortSmoke) throw new Error(`LOAD_TEST_POLL_DURATION must cover ${cycles} schedule windows and the staleness threshold (${requiredDurationMilliseconds / 60000} minutes); only explicit LOAD_TEST_ALLOW_SHORT_SMOKE=true permits a shorter smoke run`)
  const recommendedReadinessTimeoutMilliseconds = (runtime.organisationPollIntervalSeconds + 2 * windowSeconds + capacityLowerBoundSeconds + runtime.obligationPollIntervalSeconds) * 1000
  const readinessTimeoutMilliseconds = integerSetting(env, 'LOAD_TEST_READINESS_TIMEOUT_MS', recommendedReadinessTimeoutMilliseconds, 1, 86400000)
  if (readinessTimeoutMilliseconds < recommendedReadinessTimeoutMilliseconds && !shortSmoke) throw new Error(`LOAD_TEST_READINESS_TIMEOUT_MS is below the derived discovery/hydration budget ${recommendedReadinessTimeoutMilliseconds}; increase it or explicitly choose a short smoke run`)
  const journeyRatePerMinute = Number(env.LOAD_TEST_JOURNEY_RATE_PER_MINUTE ?? 1)
  if (!Number.isFinite(journeyRatePerMinute) || journeyRatePerMinute <= 0 || journeyRatePerMinute > 600) throw new Error('LOAD_TEST_JOURNEY_RATE_PER_MINUTE must be greater than 0 and at most 600')
  const journeyLimit = integerSetting(env, 'LOAD_TEST_JOURNEY_LIMIT', env.LOAD_TEST_BROWSER_SAMPLE_COUNT ?? poolSize, 1, poolSize)
  const maximumUniqueJourneys = Math.min(poolSize, journeyLimit, Math.ceil(measuredDurationMilliseconds * journeyRatePerMinute / 60000))
  const acceptPercentage = Number(env.LOAD_TEST_ACCEPT_PERCENTAGE ?? 50)
  if (!Number.isFinite(acceptPercentage) || acceptPercentage < 0 || acceptPercentage > 100) throw new Error('LOAD_TEST_ACCEPT_PERCENTAGE must be between 0 and 100')
  return { runtime, capacityLowerBoundSeconds, windowSeconds, cycles, measuredDurationMilliseconds,
    requiredDurationMilliseconds, readinessTimeoutMilliseconds, recommendedReadinessTimeoutMilliseconds,
    shortSmoke, journeyRatePerMinute, journeyLimit, maximumUniqueJourneys, acceptPercentage,
    journeyConcurrency: integerSetting(env, 'LOAD_TEST_JOURNEY_CONCURRENCY', 4, 1, 100) }
}
