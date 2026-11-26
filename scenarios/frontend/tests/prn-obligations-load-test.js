// Browser load test of the Accept & Reject PRNs and Manage Obligations pages.
// LOAD_TEST_PRN_USER_COUNT virtual users (LOAD_TEST_CSO_PERCENTAGE of them
// compliance scheme users) each sign in once with their own session, then run
// every journey LOAD_TEST_PRN_USER_ITERATIONS times, concurrently with the others.
// With LOAD_TEST_PRN_ITERATION_PACING_MS each user starts an iteration once per
// pacing interval, so the run lasts iterations × pacing and makes users ×
// iterations journeys whatever the response times. The users' starts are spread
// evenly over one pacing interval, so iterations start at a steady rate.
// LOAD_TEST_PRN_THINK_TIME_MS
// adds an untimed pause before each step (lib/prn-pacing.js).
// Each step is timed as in csoc-load-test.js; the run fails on any failed step
// or a step whose P95 exceeds LOAD_TEST_PRN_STEP_P95_MS.
//
// Off LOCAL, each user works on its own organisation: the load-test stub
// allocates one per user, the user sends that allocation's
// X-EPR-Load-Test-Session header, and accepts and rejects only that
// organisation's notes. On LOCAL there are no allocations, so all users of an
// account share its organisation; the run first gives each account lots of
// notes and restores the PRN database afterwards. Either way the users of one
// organisation share its notes through one pool, so concurrent journeys never
// accept or reject the same note.

import { chromium } from '@playwright/test'
import { randomInt } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { baseUrl, obligationYear } from '../lib/config.js'
import { signInAt } from '../lib/auth.js'
import { journeys, journeyContext, signInTarget } from '../lib/prn-obligations-steps.js'
import { runJourney } from '../lib/prn-journey-runner.js'
import {
  iterationPacingMilliseconds,
  spreadThinkTime,
  staggeredStartMilliseconds,
  thinkTimeMilliseconds,
  waitBeforeIteration
} from '../lib/prn-pacing.js'
import { PrnPool } from '../lib/prn-pool.js'
import { localPrnDataEnabled, prepareLocalPrns, prnsPerAccount, restoreLocalPrns } from '../lib/local-prn-data.js'
import {
  initialiseLoadTestSession,
  loadTestSessionHeaders,
  loadTestUserIterations,
  loadTestUserMix,
  loadTestUserStartJitterMilliseconds
} from '../lib/load-test-session.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.resolve(__dirname, '..', 'results', 'prn-obligations-load')
const SIGN_IN_CONCURRENCY = 5
// Each allocated organisation's pool is read from the API before the run.
const POOL_LOAD_CONCURRENCY = 5

// Notes each iteration of every journey uses: accept 1, reject 1, accept selected 2.
const NOTES_PER_ITERATION = 4

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function requireEnvironmentValue(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} must be set in the environment`)
  }
  return value
}

function stepP95Threshold() {
  const raw = process.env.LOAD_TEST_PRN_STEP_P95_MS ?? '3000'
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`LOAD_TEST_PRN_STEP_P95_MS must be a positive number, got '${raw}'`)
  }
  return value
}

function accountsForMix({ directProducerUserCount, complianceSchemeUserCount }) {
  const accounts = []
  if (directProducerUserCount > 0) {
    accounts.push({
      type: 'dp',
      label: 'Direct Producer',
      userCount: directProducerUserCount,
      email: requireEnvironmentValue('EPR_USER_EMAIL'),
      password: requireEnvironmentValue('EPR_USER_PASSWORD'),
      organisationId: requireEnvironmentValue('EPR_ORG_ID'),
      journey: 'producer'
    })
  }
  if (complianceSchemeUserCount > 0) {
    accounts.push({
      type: 'cso',
      label: 'Compliance Scheme Officer',
      userCount: complianceSchemeUserCount,
      email: requireEnvironmentValue('EPR_CSO_USER_EMAIL'),
      password: requireEnvironmentValue('EPR_CSO_USER_PASSWORD'),
      organisationId: requireEnvironmentValue('WASTE_OBLIGATION_CSO_ORG_ID'),
      journey: 'cso'
    })
  }
  return accounts
}

function startDelay(jitter) {
  return jitter > 0 ? randomInt(0, jitter + 1) : 0
}

// Orders users so the account types alternate in proportion (for 10 DP and 30
// CSO: one DP every four users), for an even mix over a staggered start.
function interleaveByAccount(users) {
  return users
    .map((user) => {
      const ofType = users.filter((other) => other.account.type === user.account.type)
      return { user, rank: (ofType.indexOf(user) + 0.5) / ofType.length }
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ user }) => user)
}

function checkPoolSize(label, pool, needed) {
  console.log(`[${label}] ${pool.remaining} PRNs and PERNs awaiting acceptance; the run uses ${needed}`)
  if (pool.remaining < needed) {
    throw new Error(`${label} has ${pool.remaining} notes awaiting acceptance but the run needs ${needed}`)
  }
}

// Runs `task` over `items`, at most `limit` at a time.
async function mapLimited(items, limit, task) {
  const results = new Array(items.length)
  let next = 0

  async function worker() {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await task(items[index])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// One user per organisation the load-test stub allocates for this run. Users
// still sign in as the account's seeded login; the X-EPR-Load-Test-Session
// header tells the stub which allocated organisation that user is acting for.
async function usersForAllocations(accounts, mix, { year, iterationCount, jitter }) {
  const { runId, directProducerAllocations, complianceSchemeAllocations } = await initialiseLoadTestSession({ mix })
  console.log(`Initialised load-test run ${runId}`)

  const accountByType = new Map(accounts.map((account) => [account.type, account]))
  const allocated = [
    ...directProducerAllocations.map((allocation) => ({ account: accountByType.get('dp'), allocation })),
    ...complianceSchemeAllocations.map((allocation) => ({ account: accountByType.get('cso'), allocation }))
  ].map((entry, position) => ({ ...entry, index: position + 1 }))
  const needed = iterationCount * NOTES_PER_ITERATION

  return mapLimited(allocated, POOL_LOAD_CONCURRENCY, async ({ account, allocation, index }) => {
    const { organisationId, userIndex } = allocation
    const pool = await PrnPool.load(organisationId, year)
    checkPoolSize(`${account.label} ${organisationId}`, pool, needed)
    const user = {
      index,
      account,
      organisationId,
      headers: loadTestSessionHeaders(runId, userIndex),
      pool,
      startDelayMilliseconds: startDelay(jitter)
    }
    console.log(`[user ${user.index} (${account.type})] X-EPR-Load-Test-Session=${runId}:${userIndex} -> organisation ${organisationId}`)
    return user
  })
}

// LOCAL: every user of an account works on that account's one organisation.
async function usersForSharedAccounts(accounts, { year, iterationCount, jitter }) {
  const users = []

  for (const account of accounts) {
    const pool = await PrnPool.load(account.organisationId, year)
    checkPoolSize(account.label, pool, account.userCount * iterationCount * NOTES_PER_ITERATION)
    for (let n = 0; n < account.userCount; n++) {
      users.push({
        index: users.length + 1,
        account,
        organisationId: account.organisationId,
        headers: undefined,
        pool,
        startDelayMilliseconds: startDelay(jitter)
      })
    }
  }

  return users
}

// Each virtual user signs in once in its own context: the multi-select
// journey keeps its selection in the session, so users can't share one.
async function signInUsers(browser, users, url) {
  const queue = [...users]

  async function worker() {
    for (let user = queue.shift(); user; user = queue.shift()) {
      const context = await browser.newContext({
        baseURL: url,
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 720 }
      })
      const page = await context.newPage()
      const target = signInTarget(user.account.journey, user.account.organisationId)
      await signInAt(page, { email: user.account.email, password: user.account.password, ...target })
      await page.close()
      user.storageState = await context.storageState()
      await context.close()
      console.log(`[user ${user.index} (${user.account.type})] signed in`)
    }
  }

  await Promise.all(Array.from({ length: Math.min(SIGN_IN_CONCURRENCY, users.length) }, worker))
}

async function runUser(browser, user, url, { iterationCount, pacingMilliseconds, thinkTimeMilliseconds }) {
  const rows = []
  let lateIterations = 0
  const thinkTime = () => spreadThinkTime(thinkTimeMilliseconds)

  if (user.startDelayMilliseconds > 0) {
    await delay(user.startDelayMilliseconds)
  }
  const userStartedAt = Date.now()

  for (let iteration = 1; iteration <= iterationCount; iteration++) {
    const wait = waitBeforeIteration({ iteration, userStartedAt, pacingMilliseconds, now: Date.now() })
    if (wait > 0) {
      await delay(wait)
    } else if (pacingMilliseconds > 0 && iteration > 1) {
      lateIterations++
      console.log(`[user ${user.index} (${user.account.type}) iteration ${iteration}/${iterationCount}] started late: the previous iteration overran its ${pacingMilliseconds}ms slot`)
    }

    for (const journey of journeys) {
      // A fresh context per journey from the user's own session, as the CSoC
      // load test uses one per iteration.
      const context = await browser.newContext({
        storageState: user.storageState,
        baseURL: url,
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 720 },
        extraHTTPHeaders: user.headers
      })

      try {
        const page = await context.newPage()
        const ctx = journeyContext(user.account.journey, user.organisationId, user.pool)
        const journeyRows = await runJourney(page, journey, ctx, { thinkTime })

        for (const row of journeyRows) {
          rows.push({ user: user.index, accountType: user.account.type, iteration, ...row })
          const outcome = row.skipped ? `SKIPPED (${row.skipped})` : row.passed ? `${row.elapsed}ms ✓` : `FAILED — ${row.error}`
          console.log(`[user ${user.index} (${user.account.type}) iteration ${iteration}/${iterationCount}] ${row.step} ${outcome}`)
        }
      } finally {
        await context.close().catch(() => {})
      }
    }
  }

  return { rows, lateIterations }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export function summarise(rows) {
  const byStep = new Map()

  for (const row of rows) {
    const key = `${row.accountType}|${row.journey}|${row.step}`
    const entry = byStep.get(key) ?? {
      accountType: row.accountType,
      journey: row.journey,
      step: row.step,
      timings: [],
      failed: 0,
      skipped: 0,
      skipReason: null
    }
    if (row.skipped) {
      entry.skipped++
      entry.skipReason = row.skipped
    } else if (!row.passed) {
      entry.failed++
    } else {
      entry.timings.push(row.elapsed)
    }
    byStep.set(key, entry)
  }

  return [...byStep.values()].map(({ timings, ...entry }) => {
    const sorted = [...timings].sort((a, b) => a - b)
    return {
      ...entry,
      count: sorted.length,
      min: sorted[0] ?? null,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.at(-1) ?? null
    }
  })
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

async function writeReport(summary, meta) {
  const cell = (value) => `<td>${value == null ? '—' : escapeHtml(value)}</td>`
  const rows = summary
    .map((entry) => {
      const status = entry.failed > 0 ? 'FAIL' : entry.skipped > 0 && entry.count === 0 ? 'SKIPPED' : entry.p95 > meta.p95Threshold ? 'FAIL (P95)' : 'PASS'
      return `<tr>${cell(entry.accountType)}${cell(entry.journey)}${cell(entry.step)}${cell(entry.count)}${cell(entry.failed)}${cell(entry.skipped ? `${entry.skipped}: ${entry.skipReason}` : 0)}${cell(entry.p50)}${cell(entry.p95)}${cell(entry.p99)}${cell(entry.max)}${cell(status)}</tr>`
    })
    .join('\n')

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>PRN and obligations load test</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:24px}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:4px 8px;text-align:left}th{background:#f3f3f3}</style></head>
<body><h1>Accept &amp; Reject PRNs and Manage Obligations: browser load test</h1>
<p>${escapeHtml(meta.startedAt)} to ${escapeHtml(meta.finishedAt)} · ${escapeHtml(meta.url)} · year ${meta.year} · ${meta.users} users (${meta.directProducerUsers} DP, ${meta.complianceSchemeUsers} CSO) · ${meta.organisations} organisation(s) · ${meta.iterations} iteration(s) each · ${meta.pacingMilliseconds > 0 ? `one iteration every ${meta.pacingMilliseconds} ms per user, ${meta.lateIterations} started late` : 'iterations back to back'} · think time ${meta.thinkTimeMilliseconds} ms before each step · step P95 threshold ${meta.p95Threshold} ms</p>
<table><thead><tr><th>Account</th><th>Journey</th><th>Step</th><th>Timed</th><th>Failed</th><th>Skipped</th><th>P50 ms</th><th>P95 ms</th><th>P99 ms</th><th>Max ms</th><th>Result</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`

  await fs.writeFile(path.join(RESULTS_DIR, 'index.html'), html)
}

async function main() {
  const url = baseUrl()
  const year = obligationYear()
  // Its own user count and iterations: the shared LOAD_TEST_USER_* values are
  // sized for the CSoC test's paced run, far beyond the notes this test has.
  const mix = loadTestUserMix({ countVariable: 'LOAD_TEST_PRN_USER_COUNT' })
  const iterationCount = loadTestUserIterations({ variable: 'LOAD_TEST_PRN_USER_ITERATIONS' })
  const jitter = loadTestUserStartJitterMilliseconds()
  const p95Threshold = stepP95Threshold()
  const pacingMilliseconds = iterationPacingMilliseconds()
  const thinkTime = thinkTimeMilliseconds()
  const accounts = accountsForMix(mix)
  // LOCAL has no load-test allocations: its PRNs live in the real PRN database.
  const perOrganisation = process.env.ENVIRONMENT !== 'local'
  const snapshotPath = path.join(RESULTS_DIR, 'local-prn-snapshot.json')
  const startedAt = new Date().toISOString()

  await fs.rm(RESULTS_DIR, { recursive: true, force: true })
  await fs.mkdir(RESULTS_DIR, { recursive: true })
  console.log(`PRN and obligations load test against ${url} for ${year}: ${mix.directProducerUserCount} DP and ${mix.complianceSchemeUserCount} CSO users, ${iterationCount} iteration(s) each, ${pacingMilliseconds > 0 ? `one every ${pacingMilliseconds}ms (about ${Math.round((iterationCount * pacingMilliseconds) / 60_000)} minutes)` : 'back to back'}, think time ${thinkTime}ms`)

  const seeded = localPrnDataEnabled()
  if (seeded) {
    const needed = Math.max(...accounts.map((account) => account.userCount)) * iterationCount * NOTES_PER_ITERATION
    const count = Math.max(prnsPerAccount(), needed)
    console.log(`LOCAL: adding ${count} PRNs and PERNs awaiting acceptance to each account`)
    await prepareLocalPrns(accounts, { count, year, snapshotPath })
  }

  const browser = await chromium.launch({
    headless: true,
    proxy: process.env.HTTP_PROXY ? { server: process.env.HTTP_PROXY } : undefined
  })
  let rows = []
  let lateIterations = 0
  let organisationCount = 0

  try {
    const users = perOrganisation
      ? await usersForAllocations(accounts, mix, { year, iterationCount, jitter })
      : await usersForSharedAccounts(accounts, { year, iterationCount, jitter })
    organisationCount = new Set(users.map((user) => user.organisationId)).size

    // Interleave the account types so both are spread over the interval, not
    // all producers first; any LOAD_TEST_USER_START_JITTER_MS is added on top.
    const interleaved = interleaveByAccount(users)
    interleaved.forEach((user, position) => {
      user.startDelayMilliseconds += staggeredStartMilliseconds({ position, userCount: users.length, pacingMilliseconds })
    })

    await signInUsers(browser, users, url)
    const perUser = await Promise.all(
      users.map((user) => runUser(browser, user, url, { iterationCount, pacingMilliseconds, thinkTimeMilliseconds: thinkTime }))
    )
    rows = perUser.flatMap((result) => result.rows)
    lateIterations = perUser.reduce((sum, result) => sum + result.lateIterations, 0)
  } finally {
    await browser.close().catch(() => {})
    if (seeded) {
      const restored = await restoreLocalPrns(snapshotPath)
      console.log(`LOCAL: generated notes deleted and ${restored} existing notes restored`)
    }
  }

  const summary = summarise(rows)
  const meta = {
    startedAt,
    finishedAt: new Date().toISOString(),
    url,
    year,
    users: mix.directProducerUserCount + mix.complianceSchemeUserCount,
    directProducerUsers: mix.directProducerUserCount,
    complianceSchemeUsers: mix.complianceSchemeUserCount,
    iterations: iterationCount,
    pacingMilliseconds,
    lateIterations,
    thinkTimeMilliseconds: thinkTime,
    organisations: organisationCount,
    p95Threshold
  }

  await fs.writeFile(path.join(RESULTS_DIR, 'load-test-results.json'), JSON.stringify({ meta, summary, rows }, null, 2))
  await writeReport(summary, meta)

  console.log('\nStep                                   Account  Timed  Failed  Skipped   P50    P95    Max')
  for (const entry of summary) {
    console.log(
      `${entry.step.padEnd(38)} ${entry.accountType.padEnd(7)} ${String(entry.count).padStart(5)} ${String(entry.failed).padStart(7)} ${String(entry.skipped).padStart(8)} ${String(entry.p50 ?? '—').padStart(6)} ${String(entry.p95 ?? '—').padStart(6)} ${String(entry.max ?? '—').padStart(6)}`
    )
  }

  const failedSteps = summary.filter((entry) => entry.failed > 0)
  const slowSteps = summary.filter((entry) => entry.p95 != null && entry.p95 > p95Threshold)
  for (const entry of failedSteps) console.error(`FAILED: ${entry.accountType} ${entry.step} failed ${entry.failed} time(s)`)
  for (const entry of slowSteps) console.error(`P95 BREACH: ${entry.accountType} ${entry.step} P95 ${entry.p95} ms > ${p95Threshold} ms`)
  if (failedSteps.length > 0 || slowSteps.length > 0) {
    process.exitCode = 1
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
