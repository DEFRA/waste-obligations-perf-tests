import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertAllocationMembership, assertMembership, catalogueReady, initialisePolling, pollingConfig, readUnsubmitted, sampleAccounts, seededRandom } from './unsubmitted-polling.mjs'
import { validUnsubmittedRow } from './unsubmitted-row.mjs'

const row = (id, year = 2026) => ({ organisationId: id, obligationYear: year, referenceNumber: '200001', recyclingObligationsMet: false, obligationCoveragePercentage: 66 })
const runtime = { eligibilityRefreshPollingEnabled: true, organisationPollIntervalSeconds: 300,
  obligationPollingEnabled: true, obligationRefreshIntervalSeconds: 1800, maximumSummaryStalenessSeconds: 3600,
  maxDownstreamRequestsPerMinute: 180, obligationPollIntervalSeconds: 60, currentObligationYear: 2026 }

test('readiness requires current manifest IDs, target year and calculated metrics', () => {
  const allocations = [{ organisationId: 'new-run-id' }]
  assert.equal(catalogueReady([], allocations, 2026), false)
  assert.equal(catalogueReady([row('old-run-id')], allocations, 2026), false)
  assert.equal(catalogueReady([row('new-run-id', 2025)], allocations, 2026), false)
  assert.equal(catalogueReady([{ ...row('new-run-id'), recyclingObligationsMet: null }], allocations, 2026), false)
  assert.equal(catalogueReady([{ ...row('new-run-id'), obligationCoveragePercentage: null }], allocations, 2026), false)
  assert.equal(catalogueReady([row('new-run-id')], allocations, 2026), true)
})

test('submission and restoration assertions use exact IDs despite growth or matching names', () => {
  assertMembership([row('other-id'), row('grown-id')], 'submitted-id', false)
  assertMembership([row('restored-id'), row('grown-id')], 'restored-id', true)
  assert.throws(() => assertMembership([row('other-id')], 'restored-id', true))
  assert.throws(() => assertMembership([row('submitted-id')], 'submitted-id', false))
})

test('random subset preserves original allocation indices and shared catalogue identities', () => {
  const accounts = Array.from({ length: 500 }, (_, index) => ({ type: index < 125 ? 'dp' : 'cso', allocation: { organisationId: `org-${index}`, userIndex: index < 125 ? index : index - 125 } }))
  const selected = sampleAccounts(accounts, 10, () => 0.5)
  assert.equal(selected.length, 10)
  assert.equal(new Set(selected.map(account => account.allocation.organisationId)).size, 10)
  assert.ok(selected.every(account => accounts.includes(account)))
  assert.equal(accounts.length, 500)
  assert.throws(() => sampleAccounts(accounts, 501))
})

test('public pagination collects all pages of at most100 before testing readiness', async () => {
  const pages = []
  const rows = await readUnsubmitted(2026, async url => {
    const page = Number(new URL(url).searchParams.get('page'))
    pages.push(page)
    return { ok: true, json: async () => ({ total: 150, unsubmittedOrganisations: Array.from({ length: page === 1 ? 100 : 50 }, (_, index) => row(`org-${page}-${index}`)) }) }
  }, { EPR_BACKEND_BASE_URL: 'http://localhost/service', AUTH_TOKEN: 'Basic test' })
  assert.deepEqual(pages, [1, 2])
  assert.equal(rows.length, 150)
})

test('initialises the shared500 mix with an uppercase caller UUID and verifies the lowercase response in the public view', async () => {
  const previousCount = process.env.LOAD_TEST_USER_COUNT
  const previousMix = process.env.LOAD_TEST_CSO_PERCENTAGE
  process.env.LOAD_TEST_USER_COUNT = '500'
  process.env.LOAD_TEST_CSO_PERCENTAGE = '75'
  try {
    const runId = 'a23c8152-2079-4f35-982a-51a137a937d6'
    const allocations = Array.from({ length: 500 }, (_, index) => ({ organisationId: `org-${index}` }))
    let initialisation
    const catalogue = await initialisePolling(async (url, options) => {
      if (url === 'http://localhost/service/admin/unsubmitted-compliance-declarations/polling-configuration') return { ok: true, json: async () => runtime }
      if (options.method === 'POST') {
        initialisation = JSON.parse(options.body)
        return { ok: true, json: async () => ({ runId, initialOrganisationCount: 500, allocations }) }
      }
      const page = Number(new URL(url).searchParams.get('page'))
      return { ok: true, json: async () => ({ total: 500, unsubmittedOrganisations: allocations.slice((page - 1) * 100, page * 100).map(allocation => row(allocation.organisationId)) }) }
    }, { EPR_AZURE_STUB_BASE_URL: 'http://localhost/stub', EPR_BACKEND_BASE_URL: 'http://localhost/service', EPR_LOAD_TEST_RUN_ID: runId.toUpperCase(), LOAD_TEST_OBLIGATION_YEAR: '2026', LOAD_TEST_READINESS_TIMEOUT_MS: '1800000', AUTH_TOKEN: 'Basic test' })
    assert.equal(initialisation.runId, runId)
    assert.equal(catalogue.runId, runId)
    assert.equal(initialisation.directProducerUserCount, 125)
    assert.equal(initialisation.complianceSchemeUserCount, 375)
    assert.equal(initialisation.organisationGrowthIntervalSeconds, 1800)
    assert.equal(initialisation.obligationChangeIntervalSeconds, 1800)
    assert.equal(initialisation.maximumAdditionalOrganisations, 288)
    assert.equal(catalogue.allocations.length, 500)
    assert.equal(catalogue.timing.shortSmoke, false)
    assert.equal(catalogue.timing.measuredDurationMilliseconds, 3600000)
    assert.equal(catalogue.timing.effectiveReadinessTimeoutMilliseconds, 1800000)
  } finally {
    if (previousCount === undefined) delete process.env.LOAD_TEST_USER_COUNT; else process.env.LOAD_TEST_USER_COUNT = previousCount
    if (previousMix === undefined) delete process.env.LOAD_TEST_CSO_PERCENTAGE; else process.env.LOAD_TEST_CSO_PERCENTAGE = previousMix
  }
})

test('lease shell function canonicalises a valid uppercase UUID and rejects an invalid identity', () => {
  const leaseLibrary = fileURLToPath(new URL('./load-test-run-lease.sh', import.meta.url))
  const invoke = runId => execFileSync('sh', ['-c', '. "$1"; load_test_run_lease_id', 'lease-test', leaseLibrary], {
    env: { ...process.env, EPR_LOAD_TEST_RUN_ID: runId }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  })
  assert.equal(invoke('A23C8152-2079-4F35-982A-51A137A937D6'), 'a23c8152-2079-4f35-982a-51a137a937d6')
  assert.throws(() => invoke('not-a-uuid'))
})

test('750 initial organisations plus288 growth are sent as one shared pool with independent source periods', async () => {
  const savedCount = process.env.LOAD_TEST_USER_COUNT
  const savedPercentage = process.env.LOAD_TEST_CSO_PERCENTAGE
  process.env.LOAD_TEST_USER_COUNT = '750'
  process.env.LOAD_TEST_CSO_PERCENTAGE = '75'
  try {
    const runId = 'a23c8152-2079-4f35-982a-51a137a937d6'
    const allocations = Array.from({ length: 750 }, (_, index) => ({ organisationId: `org-${index}` }))
    const calls = []
    let payload
    const result = await initialisePolling(async (url, options) => {
      calls.push(url)
      if (url === 'http://localhost/service/admin/unsubmitted-compliance-declarations/polling-configuration') return { ok: true, json: async () => runtime }
      if (options.method === 'POST') {
        payload = JSON.parse(options.body)
        return { ok: true, json: async () => ({ runId, initialOrganisationCount: 750, allocations }) }
      }
      const page = Number(new URL(url).searchParams.get('page'))
      return { ok: true, json: async () => ({ total: 750, unsubmittedOrganisations: allocations.slice((page - 1) * 100, page * 100).map(allocation => row(allocation.organisationId)) }) }
    }, { EPR_AZURE_STUB_BASE_URL: 'http://localhost/stub', EPR_BACKEND_BASE_URL: 'http://localhost/service',
      EPR_LOAD_TEST_RUN_ID: runId, AUTH_TOKEN: 'Basic test', LOAD_TEST_ORGANISATION_GROWTH_INTERVAL_SECONDS: '120', LOAD_TEST_OBLIGATION_CHANGE_INTERVAL_SECONDS: '300' })
    assert.equal(calls[0], 'http://localhost/service/admin/unsubmitted-compliance-declarations/polling-configuration')
    assert.equal(payload.directProducerUserCount, 187)
    assert.equal(payload.complianceSchemeUserCount, 563)
    assert.equal(payload.maximumAdditionalOrganisations, 288)
    assert.equal(payload.organisationGrowthIntervalSeconds, 120)
    assert.equal(payload.obligationChangeIntervalSeconds, 300)
    assert.equal(result.year, 2026)
    assert.equal(result.timing.measuredDurationMilliseconds, 3600000)
  } finally {
    if (savedCount === undefined) delete process.env.LOAD_TEST_USER_COUNT; else process.env.LOAD_TEST_USER_COUNT = savedCount
    if (savedPercentage === undefined) delete process.env.LOAD_TEST_CSO_PERCENTAGE; else process.env.LOAD_TEST_CSO_PERCENTAGE = savedPercentage
  }
})

test('polling settings reject unregistered year and invalid bounds', () => {
  assert.throws(() => pollingConfig({ LOAD_TEST_OBLIGATION_YEAR: '2024' }))
  assert.throws(() => pollingConfig({ LOAD_TEST_OBLIGATION_YEAR: '2026', LOAD_TEST_CHANGE_INTERVAL_SECONDS: '0' }))
  assert.throws(() => pollingConfig({ LOAD_TEST_OBLIGATION_YEAR: '2026', LOAD_TEST_MAX_ADDITIONAL_ORGANISATIONS: '-1' }))
})

test('combined membership searches the scheme name and type then proves exact ID absence repeatedly', async () => {
  let count = 0
  await assertAllocationMembership({ organisationId: 'chosen-id', operatorOrganisationId: 'operator-id', complianceSchemeName: 'Scheme 27' }, 2026, false,
    async url => {
      count++
      const query = new URL(url).searchParams
      assert.equal(query.get('search'), 'Scheme 27')
      assert.equal(query.get('registrationType'), 'ComplianceScheme')
      assert.equal(query.get('obligationYear'), '2026')
      return { ok: true, json: async () => ({ total: 1, unsubmittedOrganisations: [row('same-name-old-run-id')] }) }
    }, { EPR_BACKEND_BASE_URL: 'http://localhost/service', AUTH_TOKEN: 'Basic test' })
  assert.equal(count, 3)
})

test('optional seed makes selection repeatable without changing allocation indices', () => {
  const accounts = Array.from({ length: 100 }, (_, userIndex) => ({ allocation: { userIndex } }))
  assert.deepEqual(sampleAccounts(accounts, 10, seededRandom('run')), sampleAccounts(accounts, 10, seededRandom('run')))
  assert.notDeepEqual(sampleAccounts(accounts, 10, seededRandom('run')), sampleAccounts(accounts, 10, seededRandom('different')))
})

test('initial IDs retain calculated metrics while new growth may await hydration', () => {
  const initialIds = new Set(['initial-id'])
  const initial = { ...row('initial-id'), registrationType: 'DirectProducer' }
  assert.equal(validUnsubmittedRow(initial, 2026, initialIds), true)
  assert.equal(validUnsubmittedRow({ ...initial, recyclingObligationsMet: null }, 2026, initialIds), false)
  const growing = { ...initial, organisationId: 'new-id', recyclingObligationsMet: null, obligationCoveragePercentage: null }
  assert.equal(validUnsubmittedRow(growing, 2026, initialIds), true)
  assert.equal(validUnsubmittedRow({ ...growing, obligationYear: 2025 }, 2026, initialIds), false)
  assert.equal(validUnsubmittedRow({ ...growing, referenceNumber: null }, 2026, initialIds), false)
})


test('polling year uses service current year and preserves explicit historical selection', () => {
  assert.equal(pollingConfig({}, 2027).year, 2027)
  assert.equal(pollingConfig({ LOAD_TEST_OBLIGATION_YEAR: '2025' }, 2027).year, 2025)
  assert.throws(() => pollingConfig({}), /LOAD_TEST_OBLIGATION_YEAR/)
})
