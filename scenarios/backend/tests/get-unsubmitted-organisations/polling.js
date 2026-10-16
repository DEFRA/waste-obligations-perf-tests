import http from 'k6/http'
import { check, sleep } from 'k6'
import { baseUrl, headers, httpParams } from '../../lib/config.js'
import { buildHandleSummary } from '../../lib/summary.js'
import { findUnsubmittedOrganisation } from '../../../../lib/unsubmitted-search.mjs'
import { validUnsubmittedRow } from '../../../../lib/unsubmitted-row.mjs'

if (!__ENV.LOAD_TEST_CATALOGUE_PATH) throw new Error('Use root PROFILE=unsubmitted or unsubmitted-journey to initialise the shared polling catalogue before running this script')
const catalogue = JSON.parse(open(__ENV.LOAD_TEST_CATALOGUE_PATH))
const year = Number(__ENV.LOAD_TEST_OBLIGATION_YEAR ?? catalogue.year)
const rate = Number(__ENV.LOAD_TEST_POLL_RATE_PER_MINUTE ?? 60)
const combined = __ENV.PROFILE === 'unsubmitted-journey'
const sharedStartAt = combined ? Number(open(__ENV.LOAD_TEST_START_FILE)) : null
const minimumCount = combined ? 0 : catalogue.initialOrganisationCount
const initialIds = new Set(catalogue.allocations.slice(0, catalogue.initialOrganisationCount).map(allocation => allocation.organisationId))
if (!Number.isInteger(rate) || rate < 1 || rate > 6000) throw new Error('LOAD_TEST_POLL_RATE_PER_MINUTE must be 1–6000')

export const options = {
  scenarios: { polling: { executor: 'constant-arrival-rate', rate, timeUnit: '1m',
    duration: `${catalogue.timing.measuredDurationMilliseconds}ms`, preAllocatedVUs: 5, maxVUs: 50 } },
  thresholds: { checks: ['rate==1'], http_req_failed: ['rate<0.01'], dropped_iterations: ['count==0'] }
}

export function setup() {
  if (combined) {
    if (!Number.isFinite(sharedStartAt)) throw new Error('Invalid common workload start timestamp')
    sleep(Math.max(0, (sharedStartAt - Date.now()) / 1000))
  }
}

export default function () {
  const allocation = catalogue.allocations[Math.floor(Math.random() * catalogue.initialOrganisationCount)]
  const type = allocation.operatorOrganisationId ? 'ComplianceScheme' : 'DirectProducer'
  const minimumTypeCount = Math.max(0, catalogue.allocations.slice(0, catalogue.initialOrganisationCount)
    .filter(item => !!item.operatorOrganisationId === !!allocation.operatorOrganisationId).length)
  const variant = __ITER % 4
  const query = variant === 0 ? '&pageSize=100&page=1&sort=Name[asc]'
    : variant === 1 ? `&registrationType=${type}&country=GB-ENG&pageSize=20&page=1&sort=ReferenceNumber[desc]`
      : variant === 2 ? `&search=${encodeURIComponent(allocation.complianceSchemeName ?? allocation.organisationName)}&pageSize=100&page=1`
        : '&pageSize=50&page=2&sort=ObligationCoveragePercentage[asc]'
  const response = http.get(`${baseUrl()}/compliance-declarations/unsubmitted?obligationYear=${year}${query}`, { headers: headers(), ...httpParams })
  let body
  try { body = response.json() } catch { body = {} }
  const chosenIdPresent = variant !== 2 || combined || findUnsubmittedOrganisation(body, allocation.organisationId, page => {
    const next = http.get(`${baseUrl()}/compliance-declarations/unsubmitted?obligationYear=${year}${query.replace('&page=1', `&page=${page}`)}`, { headers: headers(), ...httpParams })
    check(next, { 'name search page returns 200': result => result.status === 200 })
    try { return next.json() } catch { return {} }
  })
  check(response, {
    'unsubmitted returns 200': result => result.status === 200,
    'valid paged count': () => Number.isInteger(body.total) && body.total >= 0 && Array.isArray(body.unsubmittedOrganisations),
    'initial pool retained in polling-only mode': () => combined || (variant !== 0 && variant !== 3) || body.total >= minimumCount,
    'initial metrics retained and growing rows valid for selected year': () => Array.isArray(body.unsubmittedOrganisations)
      && body.unsubmittedOrganisations.every(row => validUnsubmittedRow(row, year, initialIds, combined)),
    'registration filter respected': () => variant !== 1 || body.unsubmittedOrganisations?.every(row => row.registrationType === type),
    'typed pool retained in polling-only mode': () => combined || variant !== 1 || body.total >= minimumTypeCount,
    'name search retains exact chosen ID in polling-only mode': () => chosenIdPresent
  })
}

export function handleSummary(data) {
  const directory = __ENV.RESULTS_DIR ?? 'results/unsubmitted-polling'
  return { ...buildHandleSummary(directory)(data),
    [`${directory}/run-configuration.json`]: JSON.stringify({ year, timing: catalogue.timing, sourceConfiguration: catalogue.sourceConfiguration }, null, 2) }
}
