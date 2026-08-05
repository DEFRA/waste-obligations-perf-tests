import { chromium } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  baseUrl,
  csoSteps,
  directProducerSteps,
  obligationYear
} from '../lib/config.js'
import { signInAs } from '../lib/auth.js'
import { cancelExistingDeclarations } from '../lib/api-reset.js'
import {
  initialiseLoadTestSession,
  loadTestUserMix,
  loadTestSessionHeaders
} from '../lib/load-test-session.js'
import { writeLoadTestIndex } from '../lib/report-index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PARENT_RESULTS_DIR = path.resolve(__dirname, '..', 'results')
const RESULTS_DIR = path.join(PARENT_RESULTS_DIR, 'load-test')

async function measureStep(page, action, expectHeading) {
  const t0 = Date.now()
  let ttfb = null
  let dcl = null
  let load = null

  // Skip redirects; capture TTFB from the final document response only
  const onResponse = (response) => {
    if (
      response.request().isNavigationRequest() &&
      response.status() < 300 &&
      ttfb === null
    ) {
      ttfb = Math.round(response.timing().responseStart)
    }
  }
  const onDCL = () => {
    if (dcl === null) dcl = Date.now() - t0
  }
  const onLoad = () => {
    if (load === null) load = Date.now() - t0
  }

  page.on('response', onResponse)
  page.on('domcontentloaded', onDCL)
  page.on('load', onLoad)

  try {
    await action()
    await page
      .getByRole('heading', { name: expectHeading })
      .waitFor({ timeout: 30_000 })
    const elapsed = Date.now() - t0
    // Fallback: give load event up to 5s if it hasn't fired yet
    if (load === null) {
      await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {
        console.log(
          '[measureStep] load event did not fire within 5s — load metric will be null'
        )
      })
    }
    return { elapsed, ttfb, dcl, load, passed: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Log unexpected errors (non-timeouts) at error level — they may be code defects
    if (!message.includes('Timeout') && !(err.constructor?.name === 'TimeoutError')) {
      console.error(
        `[measureStep] Unexpected error (may be a code defect): ${message}`
      )
    }
    return {
      elapsed: Date.now() - t0,
      ttfb,
      dcl,
      load,
      passed: false,
      error: message
    }
  } finally {
    page.off('response', onResponse)
    page.off('domcontentloaded', onDCL)
    page.off('load', onLoad)
  }
}

async function runUser(browser, virtualUserIndex, account, url, runId, year) {
  const { allocation, storageState, type: accountType } = account
  const { organisationId, userIndex } = allocation
  const isComplianceScheme = accountType === 'cso'
  const steps = isComplianceScheme ? csoSteps : directProducerSteps
  const startPath = isComplianceScheme
    ? `/compliance/cso/${organisationId}/statement?year=${year}`
    : `/compliance/producer/${organisationId}/certificate?year=${year}`
  let ctx
  let timings = []
  let cancelledDeclarationCount

  try {
    ctx = await browser.newContext({
      storageState,
      baseURL: url,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
      extraHTTPHeaders: loadTestSessionHeaders(runId, userIndex)
    })
    const page = await ctx.newPage()

    for (const step of steps) {
      const action =
        step === steps[0]
          ? () => page.goto(startPath)
          : () => step.enter(page)

      const result = await measureStep(page, action, step.expectHeading)
      timings.push({ step: step.name, ...result })

      if (result.passed) {
        console.log(
          `[user ${virtualUserIndex} (${accountType})] ${step.name} ${result.elapsed}ms ✓`
        )
      } else {
        console.log(
          `[user ${virtualUserIndex} (${accountType})] ${step.name} FAILED — ${result.error?.split('\n')[0]}`
        )
        break
      }
    }
  } finally {
    try {
      await ctx?.close()
    } catch (closeErr) {
      console.log(
        `[user ${virtualUserIndex} (${accountType})] ctx.close() failed: ${closeErr.message}`
      )
    }

    // Every virtual user receives a generated organisation ID. Clear any declaration
    // made by this browser context while that allocation is still present in the stub.
    cancelledDeclarationCount = await cancelDeclarations(
      organisationId,
      accountType,
      year
    )
    console.log(
      `[user ${virtualUserIndex} (${accountType})] Cancelled ${cancelledDeclarationCount} declaration(s)`
    )
  }

  return {
    userIndex: virtualUserIndex,
    loadTestUserIndex: userIndex,
    accountType,
    organisationId,
    cancelledDeclarationCount,
    timings
  }
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1
  return sortedArr[Math.max(0, idx)]
}

function summarise(allTimings) {
  const byStep = {}
  for (const { step, elapsed, passed } of allTimings) {
    if (!byStep[step]) byStep[step] = { pass: [], fail: 0 }
    if (passed) {
      byStep[step].pass.push(elapsed)
    } else {
      byStep[step].fail++
    }
  }

  const rows = []
  for (const [step, { pass, fail }] of Object.entries(byStep)) {
    pass.sort((a, b) => a - b)
    rows.push({
      step,
      pass: pass.length,
      fail,
      min: pass[0] ?? null,
      p50: percentile(pass, 50),
      p95: percentile(pass, 95),
      max: pass[pass.length - 1] ?? null
    })
  }
  return rows
}

function printSummary(rows, concurrency) {
  console.log(`\n=== LOAD TEST SUMMARY — ${concurrency} users ===\n`)
  const header =
    'Step                   Pass  Fail  Min(ms)  P50(ms)  P95(ms)  Max(ms)'
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const r of rows) {
    const fmt = (v) => (v == null ? '—' : String(v)).padStart(7)
    const stepCol = r.step.padEnd(22)
    const passCol = String(r.pass).padStart(5)
    const failCol = String(r.fail).padStart(5)
    console.log(
      `${stepCol}  ${passCol} ${failCol} ${fmt(r.min)} ${fmt(r.p50)} ${fmt(r.p95)} ${fmt(r.max)}`
    )
  }
  console.log()
}

async function authenticate(browser, url, credentials) {
  let authCtx
  try {
    authCtx = await browser.newContext({
      baseURL: url,
      ignoreHTTPSErrors: true
    })
    const authPage = await authCtx.newPage()
    await signInAs(authPage, credentials)
    const storageState = await authCtx.storageState()
    if (!storageState.cookies?.length) {
      throw new Error(
        `signInAs(${credentials.orgId}) completed but storageState has no cookies — ` +
          'the B2C session was not established. Check credentials and B2C configuration.'
      )
    }
    return storageState
  } finally {
    try {
      await authCtx?.close()
    } catch (closeErr) {
      console.error(`authCtx.close() failed: ${closeErr.message}`)
    }
  }
}

async function cancelDeclarations(organisationId, type, year) {
  try {
    return await cancelExistingDeclarations(organisationId, year)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Declaration cancellation failed for ${type} organisation ${organisationId}: ${message}`
    )
  }
}

async function main() {
  const dpEmail = process.env.EPR_USER_EMAIL
  const dpPassword = process.env.EPR_USER_PASSWORD
  const dpOrgId = process.env.EPR_ORG_ID
  const csoEmail = process.env.EPR_CSO_USER_EMAIL
  const csoPassword = process.env.EPR_CSO_USER_PASSWORD
  const csoOrgId = process.env.WASTE_OBLIGATION_CSO_ORG_ID
  const {
    directProducerUserCount: requestedDirectProducerUserCount,
    complianceSchemeUserCount: requestedComplianceSchemeUserCount
  } = loadTestUserMix()

  if (requestedDirectProducerUserCount > 0 && (!dpEmail || !dpPassword)) {
    throw new Error('EPR_USER_EMAIL and EPR_USER_PASSWORD must be set')
  }
  if (requestedDirectProducerUserCount > 0 && !dpOrgId) {
    throw new Error('EPR_ORG_ID must be set')
  }
  if (requestedComplianceSchemeUserCount > 0 && (!csoEmail || !csoPassword)) {
    throw new Error('EPR_CSO_USER_EMAIL and EPR_CSO_USER_PASSWORD must be set')
  }
  if (requestedComplianceSchemeUserCount > 0 && !csoOrgId) {
    throw new Error('WASTE_OBLIGATION_CSO_ORG_ID must be set')
  }

  const url = baseUrl()
  const year = obligationYear()

  await fs.rm(RESULTS_DIR, { recursive: true, force: true })
  await fs.mkdir(RESULTS_DIR, { recursive: true })

  const loadTestSession = await initialiseLoadTestSession()
  const {
    complianceSchemeAllocations,
    complianceSchemeUserCount,
    directProducerAllocations,
    directProducerUserCount,
    runId,
    userCount
  } = loadTestSession

  console.log(
    `Load test against ${url} — ${userCount} parallel users (${directProducerUserCount} DP, ${complianceSchemeUserCount} CSO)`
  )
  console.log(`Initialised load-test run ${runId}`)

  const proxy = process.env.HTTP_PROXY
    ? { server: process.env.HTTP_PROXY }
    : undefined
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors'],
    proxy
  })

  // browser.close() is guaranteed even if auth or the load test throws
  try {
    const accountTypes = [
      directProducerUserCount > 0 ? 'DP' : null,
      complianceSchemeUserCount > 0 ? 'CSO' : null
    ].filter(Boolean)
    console.log(`Authenticating ${accountTypes.join(' and ')} account(s)...`)
    const [dpAuthResult, csoAuthResult] = await Promise.allSettled([
      directProducerUserCount > 0
        ? authenticate(browser, url, {
            email: dpEmail,
            password: dpPassword,
            orgId: dpOrgId,
            journey: 'producer'
          })
        : Promise.resolve(null),
      complianceSchemeUserCount > 0
        ? authenticate(browser, url, {
            email: csoEmail,
            password: csoPassword,
            orgId: csoOrgId,
            journey: 'cso'
          })
        : Promise.resolve(null)
    ])
    const authErrors = [dpAuthResult, csoAuthResult].filter(
      (result) => result.status === 'rejected'
    )
    if (authErrors.length > 0) {
      for (const error of authErrors) console.error(error.reason.message)
      throw new Error('Authentication failed — aborting load test')
    }
    const [dpStorageState, csoStorageState] = [
      dpAuthResult.value,
      csoAuthResult.value
    ]
    console.log('Authentication complete. Starting load test...\n')

    const accounts = [
      ...directProducerAllocations.map((allocation) => ({
        type: 'dp',
        allocation,
        storageState: dpStorageState
      })),
      ...complianceSchemeAllocations.map((allocation) => ({
        type: 'cso',
        allocation,
        storageState: csoStorageState
      }))
    ]

    const runAt = new Date().toISOString()
    const settled = await Promise.allSettled(
      accounts.map((account, userIndex) =>
        runUser(browser, userIndex, account, url, runId, year)
      )
    )

    const users = settled.map((result, userIndex) =>
      result.status === 'fulfilled'
        ? result.value
        : {
            userIndex,
            accountType: accounts[userIndex].type,
            organisationId: accounts[userIndex].allocation.organisationId,
            timings: [],
            fatalError:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason ?? 'unknown rejection')
          }
    )

    const allTimings = users.flatMap((user) => user.timings)
    const summaryRows = summarise(allTimings)
    printSummary(summaryRows, userCount)

    const fatalUsers = users.filter((user) => user.fatalError)
    if (fatalUsers.length > 0) {
      console.error(
        `WARNING: ${fatalUsers.length} user(s) had fatal errors (no step timings recorded):`
      )
      for (const user of fatalUsers) {
        console.error(`  user ${user.userIndex}: ${user.fatalError}`)
      }
      process.exitCode = 1
    }

    const totalFailures = summaryRows.filter(
      (row) => row.pass === 0 && row.fail > 0
    )
    if (totalFailures.length > 0) {
      console.error(
        `\nComplete failure on: ${totalFailures.map((row) => row.step).join(', ')}`
      )
      process.exitCode = 1
    }

    const outPath = path.join(
      RESULTS_DIR,
      `load-test-${runAt.replace(/[:.]/g, '-')}.json`
    )
    await fs.writeFile(
      outPath,
      JSON.stringify(
        {
          runAt,
          runId,
          concurrency: userCount,
          directProducerUserCount,
          complianceSchemeUserCount,
          users
        },
        null,
        2
      )
    )
    console.log(`Raw results written to ${outPath}`)

    await writeLoadTestIndex(PARENT_RESULTS_DIR, RESULTS_DIR, {
      runAt,
      concurrency: userCount,
      orgId: `DP:${dpOrgId ?? 'none'} CSO:${csoOrgId ?? 'none'}`,
      users
    })
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
