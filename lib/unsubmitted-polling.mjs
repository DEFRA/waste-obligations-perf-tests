import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadTestUserMix } from '../scenarios/frontend/lib/load-test-session.js'

export function pollingConfig(env = process.env) {
  const number = (key, fallback, min, max) => {
    const value = Number(env[key] ?? fallback)
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`)
    return value
  }
  const date = new Date()
  const uk = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: 'numeric' }).formatToParts(date)
  const currentYear = Number(uk.find(part => part.type === 'year').value) - (uk.find(part => part.type === 'month').value === '1' ? 1 : 0)
  const registrationYears = (env.LOAD_TEST_REGISTRATION_YEARS ?? '2025,2026,2027,2028,2029,2030').split(',').map(Number)
  if (!registrationYears.length || registrationYears.some(year => !Number.isInteger(year) || year < 2023 || year > 2050)) throw new Error('Invalid LOAD_TEST_REGISTRATION_YEARS')
  const year = number('LOAD_TEST_OBLIGATION_YEAR', currentYear, 2023, 2050)
  if (!registrationYears.includes(year)) throw new Error('Target obligation year must be registered')
  return { registrationYears, year,
    changeIntervalSeconds: number('LOAD_TEST_CHANGE_INTERVAL_SECONDS', 300, 1, 86400),
    maximumAdditionalOrganisations: number('LOAD_TEST_MAX_ADDITIONAL_ORGANISATIONS', 288, 0, 999),
    readinessTimeoutMs: number('LOAD_TEST_READINESS_TIMEOUT_MS', 900000, 1, 3600000) }
}

export function backendUrl(env = process.env) {
  return (env.EPR_BACKEND_BASE_URL ?? `https://waste-obligations.${env.ENVIRONMENT}.cdp-int.defra.cloud`).replace(/\/$/, '')
}

export function apiHeaders(env = process.env) {
  const token = env.AUTH_TOKEN ?? Buffer.from(`${env.WASTE_OBLIGATION_USERNAME}:${env.WASTE_OBLIGATION_PASSWORD}`).toString('base64')
  return { Accept: 'application/json', Authorization: token.startsWith('Basic ') || token.startsWith('Bearer ') ? token : `Basic ${token}`,
    ...(env.X_API_KEY ? { 'x-api-key': env.X_API_KEY } : {}) }
}

export async function readUnsubmitted(year, fetcher = fetch, env = process.env, filters = {}, deadline = Infinity) {
  const rows = []
  const query = new URLSearchParams({ obligationYear: String(year), pageSize: '100', sort: 'Name[asc]', ...filters })
  for (let page = 1; ; page++) {
    query.set('page', String(page))
    const timeout = Math.min(30000, deadline - Date.now())
    if (timeout <= 0) throw new Error('Readiness deadline elapsed')
    const response = await fetcher(`${backendUrl(env)}/compliance-declarations/unsubmitted?${query}`, { headers: apiHeaders(env), signal: AbortSignal.timeout(timeout) })
    if (!response.ok) throw new Error(`Unsubmitted read failed: ${response.status}`)
    const body = await response.json()
    if (!Array.isArray(body.unsubmittedOrganisations) || !Number.isInteger(body.total)) throw new Error('Malformed unsubmitted response')
    rows.push(...body.unsubmittedOrganisations)
    if (rows.length >= body.total || body.unsubmittedOrganisations.length === 0) return rows
    if (page >= 10000) throw new Error('Unsubmitted pagination did not terminate')
  }
}

export function catalogueReady(rows, allocations, year) {
  const byId = new Map(rows.map(row => [row.organisationId, row]))
  return allocations.length > 0 && allocations.every(allocation => {
    const row = byId.get(allocation.organisationId)
    return row?.obligationYear === year && !!row.referenceNumber && typeof row.recyclingObligationsMet === 'boolean'
      && typeof row.obligationCoveragePercentage === 'number' && Number.isFinite(row.obligationCoveragePercentage)
  })
}

export function assertMembership(rows, organisationId, expected) {
  const present = rows.some(row => row.organisationId === organisationId)
  if (present !== expected) throw new Error(`Organisation ${organisationId} expected ${expected ? 'present' : 'absent'} in unsubmitted view`)
}

export async function assertAllocationMembership(allocation, year, expected, fetcher = fetch, env = process.env) {
  const filters = {
    search: allocation.complianceSchemeName ?? allocation.organisationName,
    registrationType: allocation.operatorOrganisationId ? 'ComplianceScheme' : 'DirectProducer'
  }
  let consecutive = 0
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await readUnsubmitted(year, fetcher, env, filters)
    const present = rows.some(row => row.organisationId === allocation.organisationId)
    consecutive = present === expected ? consecutive + 1 : 0
    if (consecutive >= (expected ? 1 : 3)) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Organisation ${allocation.organisationId} expected ${expected ? 'present' : 'absent'} in scoped unsubmitted view`)
}

export function sampleAccounts(accounts, count, random = Math.random) {
  if (!Number.isInteger(count) || count < 1 || count > accounts.length) throw new Error('Sample count must be between 1 and the pool size')
  const shuffled = [...accounts]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, count)
}

export function seededRandom(seed) {
  let value = 2166136261
  for (const character of String(seed)) value = Math.imul(value ^ character.charCodeAt(0), 16777619)
  return () => {
    value = (value + 0x6D2B79F5) | 0
    let next = Math.imul(value ^ (value >>> 15), 1 | value)
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

export async function initialisePolling(fetcher = fetch, env = process.env) {
  const config = pollingConfig(env)
  const runId = String(env.EPR_LOAD_TEST_RUN_ID ?? '').toLowerCase()
  const mix = loadTestUserMix()
  if (mix.userCount + config.maximumAdditionalOrganisations > 1000) throw new Error('Initial pool plus growth must not exceed 1000')
  const response = await fetcher(`${env.EPR_AZURE_STUB_BASE_URL.replace(/\/$/, '')}/admin/load-test-polling`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ runId, directProducerUserCount: mix.directProducerUserCount,
      complianceSchemeUserCount: mix.complianceSchemeUserCount, registrationYears: config.registrationYears,
      changeIntervalSeconds: config.changeIntervalSeconds, maximumAdditionalOrganisations: config.maximumAdditionalOrganisations })
  })
  if (!response.ok) throw new Error(`Polling initialisation failed: ${response.status} ${await response.text()}`)
  const catalogue = await response.json()
  if (String(catalogue.runId).toLowerCase() !== runId || catalogue.initialOrganisationCount !== mix.userCount || catalogue.allocations.length < mix.userCount) throw new Error('Unexpected polling catalogue')
  const allocations = catalogue.allocations.slice(0, mix.userCount)
  const deadline = Date.now() + config.readinessTimeoutMs
  while (true) {
    try {
      if (catalogueReady(await readUnsubmitted(config.year, fetcher, env, {}, deadline), allocations, config.year)) break
    } catch (error) { console.log(`Waiting for current catalogue: ${error.message}`) }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${allocations.length} current-run organisations with calculated metrics for ${config.year}; historical years require a backfill`)
    console.log(`Waiting for ${allocations.length} current-run organisations for ${config.year}`)
    await new Promise(resolve => setTimeout(resolve, Math.min(5000, deadline - Date.now())))
  }
  return { ...catalogue, year: config.year }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalogue = await initialisePolling()
  await writeFile(process.env.LOAD_TEST_CATALOGUE_PATH ?? 'results/polling-catalogue.json', JSON.stringify(catalogue, null, 2))
  console.log(`Ready: ${catalogue.initialOrganisationCount} current-run organisations for ${catalogue.year}`)
}
