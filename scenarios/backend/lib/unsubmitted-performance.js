import http from 'k6/http'
import exec from 'k6/execution'
import { check } from 'k6'
import { Counter, Trend } from 'k6/metrics'
import { baseUrl, headers, httpParams } from './config.js'
import { apiPerformancePlan, unsubmittedPage } from '../../../lib/unsubmitted-performance-config.mjs'
import { validUnsubmittedRow } from '../../../lib/unsubmitted-row.mjs'

const plan = apiPerformancePlan(__ENV)
const catalogue = __ENV.LOAD_TEST_API_CATALOGUE_PATH ? JSON.parse(open(__ENV.LOAD_TEST_API_CATALOGUE_PATH)) : null
const year = Number(__ENV.LOAD_TEST_OBLIGATION_YEAR ?? catalogue?.year ?? 2026)
const poolSize = catalogue?.initialOrganisationCount ?? 500
const initialIds = new Set()
if (!Number.isInteger(year) || year < 2023 || year > 2050) throw new Error('LOAD_TEST_OBLIGATION_YEAR must be an integer between 2023 and 2050')
const paginated = new Counter('unsubmitted_later_page_requests')
const totals = new Trend('unsubmitted_observed_total')
let observedTotal = 0

export function apiOptions(name) {
  if (name === 'baseline') return {
    scenarios: { baseline: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '2m' } },
    thresholds: { checks: ['rate==1.0'] }
  }
  const phase = plan.phases.find(item => item.name === name)
  return {
    scenarios: { load: { executor: 'constant-arrival-rate', rate: phase.rate, timeUnit: '1m', duration: phase.duration,
      preAllocatedVUs: 5, maxVUs: 20, gracefulStop: '30s' } },
    thresholds: { ...plan.thresholds, http_reqs: [`count>=${phase.minimumRequests}`] }
  }
}

export function readUnsubmittedPage() {
  const page = unsubmittedPage(exec.scenario.iterationInTest, poolSize, observedTotal, plan.pageSize)
  const query = `obligationYear=${year}&pageSize=${plan.pageSize}&page=${page}&sort=Name[asc]`
  const response = http.get(`${baseUrl()}/compliance-declarations/unsubmitted?${query}`, {
    headers: headers(), ...httpParams, tags: { name: 'GET /compliance-declarations/unsubmitted', page: String(page) }
  })
  let body
  try { body = response.json() ?? {} } catch { body = {} }
  const validTotal = Number.isInteger(body.total) && body.total >= 0
  if (validTotal) { observedTotal = body.total; totals.add(body.total) }
  paginated.add(page > 1 ? 1 : 0)
  check(response, {
    'status is 200': result => result.status === 200,
    'valid paged response': () => validTotal && Array.isArray(body.unsubmittedOrganisations)
      && body.unsubmittedOrganisations.length <= plan.pageSize,
    'valid target-year rows': () => Array.isArray(body.unsubmittedOrganisations)
      && body.unsubmittedOrganisations.every(row => validUnsubmittedRow(row, year, initialIds, true))
  })
}
