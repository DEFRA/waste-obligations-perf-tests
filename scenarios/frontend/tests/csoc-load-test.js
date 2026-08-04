import { chromium } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { baseUrl, csocSteps, obligationYear } from '../lib/config.js'
import { signIn } from '../lib/auth.js'
import { cancelExistingDeclarations } from '../lib/api-reset.js'
import { writeLoadTestIndex } from '../lib/report-index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PARENT_RESULTS_DIR = path.resolve(__dirname, '..', 'results')
const RESULTS_DIR = path.join(PARENT_RESULTS_DIR, 'load-test')
const CONCURRENCY = 40

async function measureStep(page, action, expectHeading) {
  const t0 = Date.now()
  let ttfb = null
  let dcl = null
  let load = null

  // Skip redirects; capture TTFB from the final document response only
  const onResponse = (response) => {
    if (response.request().isNavigationRequest() && response.status() < 300 && ttfb === null) {
      ttfb = Math.round(response.timing().responseStart)
    }
  }
  const onDCL  = () => { if (dcl  === null) dcl  = Date.now() - t0 }
  const onLoad = () => { if (load === null) load = Date.now() - t0 }

  page.on('response', onResponse)
  page.on('domcontentloaded', onDCL)
  page.on('load', onLoad)

  try {
    await action()
    await page.getByRole('heading', { name: expectHeading }).waitFor({ timeout: 30_000 })
    const elapsed = Date.now() - t0
    // Fallback: give load event up to 5s if it hasn't fired yet
    if (load === null) {
      await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {})
    }
    return { elapsed, ttfb, dcl, load, passed: true }
  } catch (err) {
    return {
      elapsed: Date.now() - t0,
      ttfb,
      dcl,
      load,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    page.off('response', onResponse)
    page.off('domcontentloaded', onDCL)
    page.off('load', onLoad)
  }
}

async function runUser(browser, userIndex, storageState, url, orgId, year) {
  let ctx
  try {
    ctx = await browser.newContext({
      storageState,
      baseURL: url,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
    })
    const page = await ctx.newPage()
    const timings = []

    for (const step of csocSteps) {
      const action = step === csocSteps[0]
        ? () => page.goto(`/compliance/producer/${orgId}/certificate?year=${year}`)
        : () => step.enter(page)

      const result = await measureStep(page, action, step.expectHeading)
      timings.push({ step: step.name, ...result })

      if (result.passed) {
        console.log(`[user ${userIndex}] ${step.name} ${result.elapsed}ms ✓`)
      } else {
        console.log(`[user ${userIndex}] ${step.name} FAILED — ${result.error?.split('\n')[0]}`)
        break
      }
    }

    return { userIndex, timings }
  } finally {
    try {
      await ctx?.close()
    } catch (closeErr) {
      console.log(`[user ${userIndex}] ctx.close() failed: ${closeErr.message}`)
    }
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
      max: pass[pass.length - 1] ?? null,
    })
  }
  return rows
}

function printSummary(rows, concurrency) {
  console.log(`\n=== LOAD TEST SUMMARY — ${concurrency} users ===\n`)
  const header = 'Step                   Pass  Fail  Min(ms)  P50(ms)  P95(ms)  Max(ms)'
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const r of rows) {
    const fmt = (v) => (v == null ? '—' : String(v)).padStart(7)
    const stepCol = r.step.padEnd(22)
    const passCol = String(r.pass).padStart(5)
    const failCol = String(r.fail).padStart(5)
    console.log(`${stepCol}  ${passCol} ${failCol} ${fmt(r.min)} ${fmt(r.p50)} ${fmt(r.p95)} ${fmt(r.max)}`)
  }
  console.log()
}

async function main() {
  if (!process.env.EPR_USER_EMAIL || !process.env.EPR_USER_PASSWORD) {
    throw new Error('EPR_USER_EMAIL and EPR_USER_PASSWORD must be set in the environment')
  }
  const orgId = process.env.EPR_ORG_ID
  if (!orgId) {
    throw new Error('EPR_ORG_ID must be set in the environment')
  }

  const url = baseUrl()
  const year = obligationYear()

  await fs.rm(RESULTS_DIR, { recursive: true, force: true })
  await fs.mkdir(RESULTS_DIR, { recursive: true })

  console.log(`Load test against ${url} — ${CONCURRENCY} parallel users`)
  console.log(`Resetting org ${orgId} declarations for year ${year}...`)
  const cancelled = await cancelExistingDeclarations(orgId, year)
  console.log(`Cancelled ${cancelled} declaration(s)`)

  const proxy = process.env.HTTP_PROXY ? { server: process.env.HTTP_PROXY } : undefined
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors'],
    proxy,
  })

  // browser.close() is guaranteed even if auth or the load test throws
  try {
    console.log('Authenticating...')
    let storageState
    let authCtx
    try {
      authCtx = await browser.newContext({ baseURL: url, ignoreHTTPSErrors: true })
      const authPage = await authCtx.newPage()
      await signIn(authPage)
      storageState = await authCtx.storageState()
      if (!storageState.cookies?.length) {
        throw new Error(
          'signIn completed but storageState has no cookies — the B2C session was not established. ' +
          'Check credentials and B2C configuration.'
        )
      }
    } finally {
      try {
        await authCtx?.close()
      } catch (closeErr) {
        console.log(`authCtx.close() failed: ${closeErr.message}`)
      }
    }
    console.log('Authentication complete. Starting load test...\n')

    const runAt = new Date().toISOString()
    const settled = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        runUser(browser, i, storageState, url, orgId, year)
      )
    )

    const users = settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            userIndex: i,
            timings: [],
            fatalError: r.reason instanceof Error ? r.reason.message : String(r.reason ?? 'unknown rejection'),
          }
    )

    const allTimings = users.flatMap((u) => u.timings)
    const summaryRows = summarise(allTimings)
    printSummary(summaryRows, CONCURRENCY)

    const fatalUsers = users.filter((u) => u.fatalError)
    if (fatalUsers.length > 0) {
      console.error(`WARNING: ${fatalUsers.length} user(s) had fatal errors (no step timings recorded):`)
      for (const u of fatalUsers) {
        console.error(`  user ${u.userIndex}: ${u.fatalError}`)
      }
      process.exitCode = 1
    }

    const totalFailures = summaryRows.filter((r) => r.pass === 0 && r.fail > 0)
    if (totalFailures.length > 0) {
      console.error(`\nComplete failure on: ${totalFailures.map((r) => r.step).join(', ')}`)
      process.exitCode = 1
    }

    const outPath = path.join(RESULTS_DIR, `load-test-${runAt.replace(/[:.]/g, '-')}.json`)
    await fs.writeFile(
      outPath,
      JSON.stringify({ runAt, concurrency: CONCURRENCY, orgId, users }, null, 2)
    )
    console.log(`Raw results written to ${outPath}`)

    await writeLoadTestIndex(PARENT_RESULTS_DIR, RESULTS_DIR, { runAt, concurrency: CONCURRENCY, orgId, users })
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
