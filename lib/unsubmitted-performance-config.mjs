import { durationMilliseconds, integerSetting } from './polling-timing.mjs'

export function apiPerformancePlan(env = {}) {
  const smoke = env.LOAD_TEST_ALLOW_SHORT_SMOKE === 'true'
  const phase = (name, rate, fallback, setting) => {
    const duration = env[setting] ?? fallback
    const milliseconds = durationMilliseconds(duration)
    if (!Number.isSafeInteger(milliseconds) || milliseconds < Math.ceil(60000 / rate) || milliseconds > 86400000) {
      throw new Error(`${setting} must allow at least one scheduled request and be at most 24h`)
    }
    if (duration !== fallback && !smoke) throw new Error(`${setting} overrides require LOAD_TEST_ALLOW_SHORT_SMOKE=true`)
    return { name, rate, duration: `${milliseconds}ms`, milliseconds, minimumRequests: Math.floor(rate * milliseconds / 60000) }
  }
  return {
    smoke,
    pageSize: 100,
    phases: [
      phase('scenario-a-load', 10, '3m', 'LOAD_TEST_API_SCENARIO_A_DURATION'),
      phase('scenario-b-stress', 40, '5m', 'LOAD_TEST_API_SCENARIO_B_DURATION')
    ],
    thresholds: { http_req_duration: ['p(95)<2000'], http_req_failed: ['rate<0.01'], checks: ['rate>0.99'], dropped_iterations: ['count==0'] }
  }
}

export function unsubmittedPage(iteration, initialPoolSize, observedTotal, pageSize = 100) {
  // A changing total may leave an empty page between reads. Still exercise later
  // pages during hydration, rather than turning the session into page-one reads.
  const pages = Math.max(1, Math.ceil(Math.max(initialPoolSize, observedTotal) / pageSize))
  return iteration % pages + 1
}

const serviceSettings = [
  'eligibilityRefreshPollingEnabled', 'organisationPollIntervalSeconds', 'obligationPollingEnabled',
  'obligationRefreshIntervalSeconds', 'maximumSummaryStalenessSeconds', 'maxDownstreamRequestsPerMinute',
  'obligationPollIntervalSeconds', 'currentObligationYear'
]

export function safeRunConfiguration(runtime, source, timing, mix, env = {}) {
  const host = value => {
    if (!value) return null
    const url = new URL(value)
    return { protocol: url.protocol, hostname: url.hostname, port: url.port }
  }
  return {
    recordedAt: new Date().toISOString(),
    profile: env.PROFILE === 'unsubmitted-journey' ? 'unsubmitted-journey' : 'unsubmitted',
    targets: {
      backend: host(env.EPR_BACKEND_BASE_URL || `https://waste-obligations.${env.ENVIRONMENT}.cdp-int.defra.cloud`),
      frontend: host(env.EPR_BASE_URL), stub: host(env.EPR_AZURE_STUB_BASE_URL)
    },
    credentialsConfigured: {
      apiAuthentication: !!(env.AUTH_TOKEN || (env.WASTE_OBLIGATION_USERNAME && env.WASTE_OBLIGATION_PASSWORD)),
      gatewayApiKey: !!env.X_API_KEY,
      browserEmail: !!env.EPR_USER_EMAIL, browserPassword: !!env.EPR_USER_PASSWORD,
      schemeBrowserEmail: !!env.EPR_CSO_USER_EMAIL, schemeBrowserPassword: !!env.EPR_CSO_USER_PASSWORD,
      producerOrganisationId: !!env.EPR_ORG_ID, schemeOrganisationId: !!env.WASTE_OBLIGATION_CSO_ORG_ID,
      submitterId: !!env.WASTE_OBLIGATION_SUBMITTER_ID, submitterEmail: !!env.WASTE_OBLIGATION_SUBMITTER_EMAIL
    },
    // Project known fields; a future service response must not silently add secrets.
    service: Object.fromEntries(serviceSettings.map(key => [key, runtime[key]])),
    source: { ...source, initialOrganisationCount: mix.userCount,
      directProducerUserCount: mix.directProducerUserCount, complianceSchemeUserCount: mix.complianceSchemeUserCount },
    session: {
      measuredDurationMilliseconds: timing.measuredDurationMilliseconds,
      requiredDurationMilliseconds: timing.requiredDurationMilliseconds,
      shortSmoke: timing.shortSmoke, cycles: timing.cycles,
      readinessTimeoutMilliseconds: timing.readinessTimeoutMilliseconds,
      effectiveReadinessTimeoutMilliseconds: timing.effectiveReadinessTimeoutMilliseconds,
      journeyRatePerMinute: timing.journeyRatePerMinute, journeyConcurrency: timing.journeyConcurrency,
      journeyLimit: timing.journeyLimit ?? null,
      pollingIterationsPerMinute: integerSetting(env, 'LOAD_TEST_POLL_RATE_PER_MINUTE', 60, 1, 6000),
      taskBudgetSeconds: integerSetting(env, 'LOAD_TEST_TASK_BUDGET_SECONDS', 7200, 1, 7200),
      authenticationTimeoutSeconds: integerSetting(env, 'LOAD_TEST_AUTH_TIMEOUT_SECONDS', 900, 0, 7200),
      leaseDurationSeconds: integerSetting(env, 'EPR_LOAD_TEST_LEASE_DURATION_SECONDS', 600, 60, 86400)
    },
    api: apiPerformancePlan(env),
    loadAccounting: 'A/B rates count dedicated unsubmitted requests only. Existing polling, readiness, browser discovery and submit/cancel verification reads are additional endpoint traffic.'
  }
}
