import { chromium } from '@playwright/test'
import { randomInt } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  baseUrl,
  csoSteps,
  directProducerSteps,
  frontendUrl,
  obligationYear
} from '../lib/config.js'
import { signInAs } from '../lib/auth.js'
import { cancelExistingDeclarations } from '../lib/api-reset.js'
import {
  initialiseLoadTestSession,
  loadTestUserMix,
  loadTestUserIterations,
  loadTestUserStartJitterMilliseconds,
  loadTestRatePerMinute,
  loadTestDurationMilliseconds,
  loadTestSessionKey,
  loadTestSessionHeaders
} from '../lib/load-test-session.js'
import { writeLoadTestIndex } from '../lib/report-index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PARENT_RESULTS_DIR = path.resolve(__dirname, '..', 'results')
const RESULTS_DIR = path.join(PARENT_RESULTS_DIR, 'load-test')

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

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
      // Playwright exposes network timing on Request, not Response.
      ttfb = Math.round(response.request().timing().responseStart)
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

async function runUser(
  browser,
  virtualUserIndex,
  account,
  url,
  runId,
  year,
  iterationCount,
  startDelayMilliseconds
) {
  const { allocation, storageState, type: accountType } = account
  const { organisationId, userIndex } = allocation
  const isComplianceScheme = accountType === 'cso'
  const sessionKey = loadTestSessionKey(runId, userIndex)
  const steps = isComplianceScheme ? csoSteps : directProducerSteps
  const startPath = isComplianceScheme
    ? frontendUrl(`/compliance/cso/${organisationId}/statement?year=${year}`)
    : frontendUrl(`/compliance/producer/${organisationId}/certificate?year=${year}`)
  let timings = []
  let cancelledDeclarationCount = 0
  let iterationsCompleted = 0
  let journeyFailed = false

  try {
    console.log(
      `[user ${virtualUserIndex} (${accountType})] correlation: X-EPR-Load-Test-Session=${sessionKey} -> user=${allocation.userId}, organisation=${organisationId}${allocation.operatorOrganisationId ? `, operatorOrganisation=${allocation.operatorOrganisationId}` : ''}`
    )

    if (startDelayMilliseconds > 0) {
      console.log(
        `[user ${virtualUserIndex} (${accountType})] start jitter: waiting ${startDelayMilliseconds}ms`
      )
      await delay(startDelayMilliseconds)
    }

    for (let iteration = 1; iteration <= iterationCount; iteration++) {
      let ctx
      let iterationPassed = true

      try {
        // Each repetition uses a fresh context seeded only with the captured
        // authenticated state, allocated organisation and load-test header.
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
          timings.push({ iteration, step: step.name, ...result })

          if (result.passed) {
            console.log(
              `[user ${virtualUserIndex} (${accountType}) iteration ${iteration}/${iterationCount}] ${step.name} ${result.elapsed}ms ✓`
            )
          } else {
            console.log(
              `[user ${virtualUserIndex} (${accountType}) iteration ${iteration}/${iterationCount}] ${step.name} FAILED — ${result.error?.split('\n')[0]}`
            )
            iterationPassed = false
            break
          }
        }
      } finally {
        try {
          await ctx?.close()
        } catch (closeErr) {
          console.log(
            `[user ${virtualUserIndex} (${accountType}) iteration ${iteration}/${iterationCount}] ctx.close() failed: ${closeErr.message}`
          )
        }
      }

      if (!iterationPassed) {
        journeyFailed = true
        break
      }

      iterationsCompleted++

      // A submitted declaration prevents the same organisation starting another
      // journey for the same year. Clear it before the next requested iteration.
      if (iteration < iterationCount) {
        const cancelledDeclarations = await cancelDeclarations(
          organisationId,
          accountType,
          year
        )
        cancelledDeclarationCount += cancelledDeclarations
        console.log(
          `[user ${virtualUserIndex} (${accountType}) iteration ${iteration}/${iterationCount}] Cancelled ${cancelledDeclarations} declaration(s) before the next iteration`
        )
      }
    }
  } finally {
    // Clear the final declaration, or any declaration left behind by a failed iteration.
    try {
      const cancelledDeclarations = await cancelDeclarations(
        organisationId,
        accountType,
        year
      )
      cancelledDeclarationCount += cancelledDeclarations
      console.log(
        `[user ${virtualUserIndex} (${accountType})] Cancelled ${cancelledDeclarations} remaining declaration(s)`
      )
    } catch (cancelErr) {
      console.error(
        `[user ${virtualUserIndex} (${accountType})] Final declaration cancel FAILED — backend may be dirty: ${cancelErr.message}`
      )
    }
  }

  return {
    userIndex: virtualUserIndex,
    loadTestUserIndex: userIndex,
    loadTestSessionKey: sessionKey,
    accountType,
    iterationsRequested: iterationCount,
    iterationsCompleted,
    journeyFailed,
    startDelayMilliseconds,
    organisationId,
    operatorOrganisationId: allocation.operatorOrganisationId,
    organisationName: allocation.organisationName,
    complianceSchemeName: allocation.complianceSchemeName,
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

function printSummary(rows, concurrency, iterationCount) {
  console.log(
    `\n=== LOAD TEST SUMMARY — ${concurrency} users × ${iterationCount} iteration${iterationCount === 1 ? '' : 's'} ===\n`
  )
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

// Runs a single end-to-end journey for one pool slot. Used by the dispatcher.
async function runJourney(browser, account, slotIndex, url, runId, year, journeyIndex) {
  const { allocation, storageState, type: accountType } = account
  const { organisationId, userIndex } = allocation
  const isComplianceScheme = accountType === 'cso'
  const steps = isComplianceScheme ? csoSteps : directProducerSteps
  const startPath = isComplianceScheme
    ? frontendUrl(`/compliance/cso/${organisationId}/statement?year=${year}`)
    : frontendUrl(`/compliance/producer/${organisationId}/certificate?year=${year}`)

  const timings = []
  let journeyFailed = false
  let cancelledDeclarationCount = 0
  let ctx

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
      timings.push({ journeyIndex, step: step.name, ...result })

      if (result.passed) {
        console.log(
          `[slot ${slotIndex} (${accountType}) journey ${journeyIndex}] ${step.name} ${result.elapsed}ms ✓`
        )
      } else {
        console.log(
          `[slot ${slotIndex} (${accountType}) journey ${journeyIndex}] ${step.name} FAILED — ${result.error?.split('\n')[0]}`
        )
        journeyFailed = true
        break
      }
    }
  } finally {
    try {
      await ctx?.close()
    } catch (closeErr) {
      console.error(
        `[slot ${slotIndex} (${accountType}) journey ${journeyIndex}] ctx.close() FAILED — context may be leaking: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`
      )
    }
    try {
      const cancelled = await cancelDeclarations(organisationId, accountType, year)
      cancelledDeclarationCount += cancelled
      if (cancelled > 0) {
        console.log(
          `[slot ${slotIndex} (${accountType}) journey ${journeyIndex}] Cancelled ${cancelled} declaration(s)`
        )
      }
    } catch (cancelErr) {
      console.error(
        `[slot ${slotIndex} (${accountType}) journey ${journeyIndex}] declaration cancel FAILED — next journey on this slot may be dirty: ${cancelErr.message}`
      )
    }
  }

  return { timings, journeyFailed, cancelledDeclarationCount }
}


async function runDispatcher(browser, accounts, url, runId, year, ratePerMinute, durationMs) {
  if (accounts.length === 0) throw new Error('runDispatcher: accounts array is empty')

  const intervalMs = Math.round(60_000 / ratePerMinute)
  const deadline = Date.now() + durationMs

  // All accounts are pre-authenticated but slots start dormant — only activated
  // when the dispatcher actually needs one. The pool grows automatically to
  // the minimum size the journey duration requires, up to accounts.length.
  const pool = accounts.map((account, i) => ({
    account,
    index: i,
    active: false,
    busy: false,
    journeys: [],
    totalCancelled: 0
  }))

  // Target ratios derived from the requested account mix.
  const dpRatio  = accounts.filter((a) => a.type === 'dp').length  / accounts.length
  const csoRatio = accounts.filter((a) => a.type === 'cso').length / accounts.length
  const dispatched = { dp: 0, cso: 0 }

  // Tracked promises — awaited after the deadline loop so no journey is dropped.
  const inFlight = new Set()

  let tick = 0
  let missedTicks = 0

  console.log(
    `[dispatcher] ${ratePerMinute}/min → 1 journey every ${intervalMs}ms · ${pool.length} slots available · duration: ${durationMs}ms`
  )

  while (Date.now() < deadline) {
    tick++
    const tickStart = Date.now()

    // Pick the account type most behind its target proportion this tick, then
    // find a free slot of that type (activating a dormant one if needed).
    // Fall back to any free/dormant slot if the preferred type is unavailable.
    const nextTotal = dispatched.dp + dispatched.cso + 1
    const preferType =
      (nextTotal * dpRatio  - dispatched.dp) >=
      (nextTotal * csoRatio - dispatched.cso) ? 'dp' : 'cso'

    const slot =
      pool.find((s) =>  s.active && !s.busy && s.account.type === preferType) ??
      pool.find((s) => !s.active            && s.account.type === preferType) ??
      pool.find((s) =>  s.active && !s.busy) ??
      pool.find((s) => !s.active)

    if (slot && !slot.active) {
      slot.active = true
      const activeCount = pool.filter((s) => s.active).length
      console.log(
        `[dispatcher] activated slot ${slot.index} (${slot.account.type}) — ${activeCount} of ${pool.length} slots now active`
      )
    }

    if (!slot) {
      console.log(`[dispatcher tick ${tick}] all ${pool.length} slots busy — missed slot`)
      missedTicks++
    } else {
      slot.busy = true
      dispatched[slot.account.type]++
      const p = runJourney(browser, slot.account, slot.index, url, runId, year, tick)
        .then((result) => {
          slot.journeys.push(result)
          slot.totalCancelled += result.cancelledDeclarationCount
        })
        .catch((err) => {
          const detail = err instanceof Error ? err.stack : String(err)
          console.error(`[slot ${slot.index}] journey ${tick} threw unexpectedly:\n${detail}`)
          slot.journeys.push({ timings: [], journeyFailed: true, cancelledDeclarationCount: 0 })
        })
        .finally(() => {
          slot.busy = false
          inFlight.delete(p)
        })
      inFlight.add(p)
    }

    const overhead = Date.now() - tickStart
    await delay(Math.max(0, intervalMs - overhead))
  }

  if (inFlight.size > 0) {
    console.log(`\n[dispatcher] deadline reached — ${tick} ticks fired, ${missedTicks} missed · awaiting ${inFlight.size} in-flight journey(s)...`)
    await Promise.allSettled(inFlight)
  } else {
    console.log(`\n[dispatcher] deadline reached — ${tick} ticks fired, ${missedTicks} missed`)
  }

  const activeSlots = pool.filter((s) => s.active).length
  const completedJourneys = pool.reduce((sum, s) => sum + s.journeys.length, 0)
  return { pool, ticks: tick, missedTicks, completedJourneys, activeSlots }
}

async function main() {
  const dpEmail = process.env.EPR_USER_EMAIL
  const dpPassword = process.env.EPR_USER_PASSWORD
  const dpOrgId = process.env.EPR_ORG_ID
  const csoEmail = process.env.EPR_CSO_USER_EMAIL
  const csoPassword = process.env.EPR_CSO_USER_PASSWORD
  const csoOrgId = process.env.WASTE_OBLIGATION_CSO_ORG_ID
  const ratePerMinute = loadTestRatePerMinute()
  const durationMs = loadTestDurationMilliseconds()

  // In dispatcher mode, auto-size the pool to ceil(rate) accounts when
  // LOAD_TEST_USER_COUNT is not explicitly set. ceil(rate) covers the worst
  // case where journeys take up to 60s — the pool will only activate as many
  // slots as the journey duration actually requires.
  if (ratePerMinute !== null && durationMs !== null && !process.env.LOAD_TEST_USER_COUNT) {
    process.env.LOAD_TEST_USER_COUNT = String(Math.ceil(ratePerMinute))
  }

  const {
    directProducerUserCount: requestedDirectProducerUserCount,
    complianceSchemeUserCount: requestedComplianceSchemeUserCount
  } = loadTestUserMix()
  const iterationCount = loadTestUserIterations()
  const startJitterMilliseconds = loadTestUserStartJitterMilliseconds()

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

  const modeLabel = ratePerMinute !== null && durationMs !== null
    ? `dispatcher mode — ${ratePerMinute}/min for ${durationMs}ms, pool: ${userCount} slots`
    : `parallel mode — ${userCount} users × ${iterationCount} iteration${iterationCount === 1 ? '' : 's'}, up to ${startJitterMilliseconds}ms start jitter`
  console.log(`Load test against ${url} — ${directProducerUserCount} DP, ${complianceSchemeUserCount} CSO — ${modeLabel}`)
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

    // Interleave DP and CSO round-robin so the dispatcher activates slots in
    // proportion to the requested mix rather than exhausting all DP slots first.
    const dpAccounts = directProducerAllocations.map((allocation) => ({
      type: 'dp',
      allocation,
      storageState: dpStorageState
    }))
    const csoAccounts = complianceSchemeAllocations.map((allocation) => ({
      type: 'cso',
      allocation,
      storageState: csoStorageState
    }))
    const accounts = []
    for (let i = 0; i < Math.max(dpAccounts.length, csoAccounts.length); i++) {
      if (i < dpAccounts.length) accounts.push(dpAccounts[i])
      if (i < csoAccounts.length) accounts.push(csoAccounts[i])
    }

    const runAt = new Date().toISOString()

    let users
    let jsonPayload
    let indexMeta

    if (ratePerMinute !== null && durationMs !== null) {
      // ── Dispatcher / arrival-rate mode ──────────────────────────────────────
      const { pool, ticks, missedTicks, completedJourneys, activeSlots } =
        await runDispatcher(browser, accounts, url, runId, year, ratePerMinute, durationMs)

      const meanJourneysPerSlot = Math.round(completedJourneys / pool.length) || 1

      users = pool.map((slot) => {
        const failedJourneyCount = slot.journeys.filter((j) => j.journeyFailed).length
        return {
          userIndex: slot.index,
          accountType: slot.account.type,
          organisationId: slot.account.allocation.organisationId,
          operatorOrganisationId: slot.account.allocation.operatorOrganisationId,
          organisationName: slot.account.allocation.organisationName,
          complianceSchemeName: slot.account.allocation.complianceSchemeName,
          cancelledDeclarationCount: slot.totalCancelled,
          journeyCount: slot.journeys.length,
          failedJourneyCount,
          timings: slot.journeys.flatMap((j) => j.timings)
        }
      })

      const allTimings = users.flatMap((u) => u.timings)
      const summaryRows = summarise(allTimings)
      console.log(
        `\n=== LOAD TEST SUMMARY — dispatcher ${ratePerMinute}/min · ${activeSlots} slots used (${pool.length} available) · ${completedJourneys} journeys · ${missedTicks} missed ticks ===\n`
      )
      printSummary(summaryRows, pool.length, meanJourneysPerSlot)

      const failedJourneys = users.reduce((sum, u) => sum + u.failedJourneyCount, 0)
      if (failedJourneys > 0) {
        console.error(`\n${failedJourneys} journey failure(s) recorded`)
        process.exitCode = 1
      }
      const failedSteps = summaryRows.filter((row) => row.fail > 0)
      if (failedSteps.length > 0) {
        console.error(`Failures on steps: ${failedSteps.map((r) => r.step).join(', ')}`)
        process.exitCode = 1
      }

      jsonPayload = {
        runAt,
        runId,
        mode: 'dispatcher',
        ratePerMinute,
        durationMs,
        poolSize: pool.length,
        directProducerUserCount,
        complianceSchemeUserCount,
        ticks,
        missedTicks,
        completedJourneys,
        peakActiveSlots: activeSlots,
        slots: pool.filter((slot) => slot.active).map((slot) => ({
          slotIndex: slot.index,
          accountType: slot.account.type,
          organisationId: slot.account.allocation.organisationId,
          organisationName: slot.account.allocation.organisationName,
          complianceSchemeName: slot.account.allocation.complianceSchemeName,
          journeyCount: slot.journeys.length,
          failedJourneyCount: slot.journeys.filter((j) => j.journeyFailed).length,
          cancelledDeclarationCount: slot.totalCancelled,
          journeys: slot.journeys
        }))
      }
      indexMeta = {
        runAt,
        concurrency: activeSlots,
        iterationsPerUser: meanJourneysPerSlot,
        userStartJitterMilliseconds: 0,
        orgId: `DP:${dpOrgId ?? 'none'} CSO:${csoOrgId ?? 'none'}`,
        metaLabel: `dispatcher · ${ratePerMinute}/min · ${activeSlots} of ${pool.length} slots used · ${completedJourneys} journeys · ${missedTicks} missed ticks`,
        users
      }
    } else {
      // ── Parallel-user / iteration-count mode (existing behaviour) ────────────
      const startDelays = accounts.map(() =>
        startJitterMilliseconds === 0
          ? 0
          : randomInt(0, startJitterMilliseconds + 1)
      )
      const settled = await Promise.allSettled(
        accounts.map((account, userIndex) =>
          runUser(
            browser,
            userIndex,
            account,
            url,
            runId,
            year,
            iterationCount,
            startDelays[userIndex]
          )
        )
      )

      users = settled.map((result, userIndex) =>
        result.status === 'fulfilled'
          ? result.value
          : {
              userIndex,
              accountType: accounts[userIndex].type,
              iterationsRequested: iterationCount,
              iterationsCompleted: 0,
              journeyFailed: true,
              startDelayMilliseconds: startDelays[userIndex],
              loadTestUserIndex: accounts[userIndex].allocation.userIndex,
              loadTestSessionKey: loadTestSessionKey(
                runId,
                accounts[userIndex].allocation.userIndex
              ),
              organisationId: accounts[userIndex].allocation.organisationId,
              operatorOrganisationId:
                accounts[userIndex].allocation.operatorOrganisationId,
              organisationName: accounts[userIndex].allocation.organisationName,
              complianceSchemeName:
                accounts[userIndex].allocation.complianceSchemeName,
              timings: [],
              fatalError:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason ?? 'unknown rejection')
            }
      )

      const allTimings = users.flatMap((user) => user.timings)
      const summaryRows = summarise(allTimings)
      printSummary(summaryRows, userCount, iterationCount)

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
      const failedSteps = summaryRows.filter((row) => row.fail > 0)
      if (failedSteps.length > 0) {
        console.error(
          `\nFailures recorded on: ${failedSteps.map((row) => row.step).join(', ')}`
        )
        process.exitCode = 1
      }

      jsonPayload = {
        runAt,
        runId,
        concurrency: userCount,
        directProducerUserCount,
        complianceSchemeUserCount,
        iterationsPerUser: iterationCount,
        userStartJitterMilliseconds: startJitterMilliseconds,
        users
      }
      indexMeta = {
        runAt,
        concurrency: userCount,
        iterationsPerUser: iterationCount,
        userStartJitterMilliseconds: startJitterMilliseconds,
        orgId: `DP:${dpOrgId ?? 'none'} CSO:${csoOrgId ?? 'none'}`,
        users
      }
    }

    const outPath = path.join(
      RESULTS_DIR,
      `load-test-${runAt.replace(/[:.]/g, '-')}.json`
    )
    await fs.writeFile(outPath, JSON.stringify(jsonPayload, null, 2))
    console.log(`Raw results written to ${outPath}`)

    await writeLoadTestIndex(PARENT_RESULTS_DIR, RESULTS_DIR, indexMeta)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
