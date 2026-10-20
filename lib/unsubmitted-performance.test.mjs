import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apiPerformancePlan, safeRunConfiguration, unsubmittedPage } from './unsubmitted-performance-config.mjs'
import { runApiSession, summaryPassed } from './unsubmitted-performance.mjs'

test('release plan delivers exactly the specified A/B arrival rates and full windows', () => {
  const plan = apiPerformancePlan()
  assert.deepEqual(plan.phases.map(({ rate, milliseconds, minimumRequests }) => [rate, milliseconds, minimumRequests]), [[10, 180000, 30], [40, 300000, 200]])
  assert.throws(() => apiPerformancePlan({ LOAD_TEST_API_SCENARIO_A_DURATION: '12s' }), /SHORT_SMOKE/)
  assert.throws(() => apiPerformancePlan({ LOAD_TEST_ALLOW_SHORT_SMOKE: 'true', LOAD_TEST_API_SCENARIO_A_DURATION: '1s' }), /at least one/)
})

test('pagination covers later pages during hydration and expands when the view grows', () => {
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => unsubmittedPage(i, 500, 0)), [1, 2, 3, 4, 5, 1])
  assert.equal(unsubmittedPage(5, 500, 501), 6)
  assert.equal(unsubmittedPage(4, 500, 1), 5) // Shrinking view can leave a valid empty page.
})

test('configuration allows only public settings and credential-presence flags', () => {
  const configuration = safeRunConfiguration({ organisationPollIntervalSeconds: 300, surpriseSecret: 'service-secret' },
    { year: 2026 }, { measuredDurationMilliseconds: 3600000, journeyConcurrency: 4 },
    { userCount: 500, directProducerUserCount: 125, complianceSchemeUserCount: 375 }, {
      EPR_BACKEND_BASE_URL: 'https://user:password@backend.example:8443/private?key=hidden',
      EPR_AZURE_STUB_BASE_URL: 'http://stub', AUTH_TOKEN: 'token-secret', X_API_KEY: 'key-secret',
      EPR_USER_EMAIL: 'private@example.com', EPR_USER_PASSWORD: 'browser-secret', UNRELATED_SECRET: 'other-secret'
    })
  const json = JSON.stringify(configuration)
  for (const secret of ['service-secret', 'password', 'private', 'hidden', 'token-secret', 'key-secret', 'browser-secret', 'other-secret']) assert.ok(!json.includes(secret), secret)
  assert.deepEqual(configuration.targets.backend, { protocol: 'https:', hostname: 'backend.example', port: '8443' })
  assert.equal(configuration.credentialsConfigured.gatewayApiKey, true)
  assert.equal(configuration.source.initialOrganisationCount, 500)
})

const summary = (ok = true) => ({ metrics: {
  checks: { values: { rate: 0.995, fails: 1 }, thresholds: { 'rate>0.99': { ok: true } } },
  iterations: { values: { count: 30 } },
  http_reqs: { values: { count: 30, rate: 1 / 6 } },
  http_req_duration: { values: { avg: 20, 'p(95)': 25 }, thresholds: { 'p(95)<2000': { ok } } }
} })

test('report verdict follows thresholds and execution, including tolerated check failures', () => {
  assert.equal(summaryPassed(summary(), 0), true)
  assert.equal(summaryPassed(summary(false), 0), false)
  assert.equal(summaryPassed(summary(), 1), false)
  assert.equal(summaryPassed(undefined, 0), false)
  assert.equal(summaryPassed({ metrics: { iterations: { values: { count: 1 } } } }, 0), false)
})

test('session repeats full A/B rounds, retains a failed round and writes reviewable reports', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'unsubmitted-api-'))
  const stop = path.join(directory, 'stop')
  const starts = path.join(directory, 'starts')
  const phases = []
  try {
    const result = await runApiSession({ LOAD_TEST_API_RESULTS_DIR: directory, LOAD_TEST_API_STOP_FILE: stop,
      LOAD_TEST_API_CATALOGUE_PATH: path.join(directory, 'catalogue'), LOAD_TEST_START_FILE: starts },
    async (script, output) => {
      phases.push(path.basename(script, '.js'))
      await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary(phases.length !== 3)))
      if (phases.length === 4) await writeFile(starts, '1700000000000')
      if (phases.length === 5) await writeFile(stop, '')
      return phases.length === 3 ? 99 : 0
    })
    assert.equal(result, 1)
    assert.deepEqual(phases, ['baseline', 'scenario-a-load', 'scenario-b-stress', 'scenario-a-load', 'scenario-b-stress'])
    const session = JSON.parse(await readFile(path.join(directory, 'session.json')))
    assert.equal(session.phases[2].passed, false)
    assert.equal(session.phases[4].passed, true)
    assert.equal(session.phases[4].journeyStartAt, '2023-11-14T22:13:20.000Z')
    const html = await readFile(path.join(directory, 'index.html'), 'utf8')
    assert.match(html, /round-002\/scenario-b-stress\/summary.html/)
    assert.match(html, /FAIL/)
    const data = JSON.parse(html.match(/window.K6_DATA = (.*?);<\/script>/)[1])
    assert.equal(data[2].pass, false)
    assert.equal(data[4].reqs, 30)
    assert.equal(data[4].reqRate, 1 / 6)
    assert.equal(data[4].avg, 20)
    assert.equal(data[4].p95, 25)
    for (const asset of ['report.css', 'report.js', 'chart.umd.min.js']) {
      assert.deepEqual(await readFile(path.join(directory, asset)), await readFile(new URL(`../scenarios/backend/lib/report/${asset}`, import.meta.url)))
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a failed baseline prevents load and an absent summary cannot produce a passing session', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'unsubmitted-api-baseline-'))
  try {
    let calls = 0
    const result = await runApiSession({ LOAD_TEST_API_RESULTS_DIR: directory, LOAD_TEST_API_STOP_FILE: path.join(directory, 'stop'),
      LOAD_TEST_API_CATALOGUE_PATH: path.join(directory, 'catalogue') }, async () => { calls++; return 0 })
    assert.equal(result, 1)
    assert.equal(calls, 1)
    const session = JSON.parse(await readFile(path.join(directory, 'session.json')))
    assert.match(session.stopReason, /Baseline failed/)
    assert.equal(session.phases[0].error, 'Missing or unreadable k6 summary')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('exhausting round budget while existing workloads continue fails even after a passing A/B round', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'unsubmitted-api-budget-'))
  try {
    let calls = 0
    const env = { LOAD_TEST_API_RESULTS_DIR: directory, LOAD_TEST_API_STOP_FILE: path.join(directory, 'stop'),
      LOAD_TEST_API_CATALOGUE_PATH: path.join(directory, 'catalogue') }
    const result = await runApiSession(env, async (_, output) => {
      calls++
      await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary()))
      if (calls === 3) env.LOAD_TEST_RUN_DEADLINE_MS = String(Date.now() + 600000)
      return 0
    })
    assert.equal(result, 1)
    assert.equal(calls, 3)
    assert.match(JSON.parse(await readFile(path.join(directory, 'session.json'))).stopReason, /No further complete/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
