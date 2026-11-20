// Lighthouse desktop and mobile audits of every Accept & Reject PRNs and
// Manage Obligations page, for a direct producer and a compliance scheme, as
// csoc-flow.js does for the CSoC pages. Each audit starts a fresh signed-in
// browser, replays its journey up to the page, then audits that URL.
//
// Steps that change notes (accept, reject, accept selected) claim fresh notes
// awaiting acceptance for every replay. On LOCAL the run first gives each
// account lots of notes and restores the PRN database afterwards.

import { chromium } from '@playwright/test'
import { playAudit } from 'playwright-lighthouse'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { auditProfiles, baseUrl, lighthouseDebugPort, obligationYear, performanceFloor } from '../lib/config.js'
import { signInAt } from '../lib/auth.js'
import { journeys, journeyContext, signInTarget } from '../lib/prn-obligations-steps.js'
import { PrnPool } from '../lib/prn-pool.js'
import { localPrnDataEnabled, prepareLocalPrns, prnsPerAccount, restoreLocalPrns } from '../lib/local-prn-data.js'
import { writeIndex } from '../lib/report-index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.resolve(__dirname, '..', 'results', 'prn-obligations-lighthouse')
const ACCOUNT_TYPES = new Set(['dp', 'cso'])
let nextDebugPort = lighthouseDebugPort

function requireEnvironmentValue(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} must be set in the environment`)
  }
  return value
}

function configuredAccounts() {
  const raw = process.env.LIGHTHOUSE_ACCOUNT_TYPES ?? 'dp,cso'
  const types = raw.split(',').map((type) => type.trim()).filter(Boolean)
  if (types.length === 0 || types.some((type) => !ACCOUNT_TYPES.has(type))) {
    throw new Error(`LIGHTHOUSE_ACCOUNT_TYPES must be a comma-separated list of dp and cso, got '${raw}'`)
  }

  return types.map((type) =>
    type === 'dp'
      ? {
          type,
          label: 'Direct Producer',
          email: requireEnvironmentValue('EPR_USER_EMAIL'),
          password: requireEnvironmentValue('EPR_USER_PASSWORD'),
          organisationId: requireEnvironmentValue('EPR_ORG_ID'),
          journey: 'producer'
        }
      : {
          type,
          label: 'Compliance Scheme Officer',
          email: requireEnvironmentValue('EPR_CSO_USER_EMAIL'),
          password: requireEnvironmentValue('EPR_CSO_USER_PASSWORD'),
          organisationId: requireEnvironmentValue('WASTE_OBLIGATION_CSO_ORG_ID'),
          journey: 'cso'
        }
  )
}

// Replays the journey's setup and steps up to `stepIndex`. Returns null when
// the page is ready, or the reason an optional page isn't offered today.
async function progressToStep(page, account, journey, stepIndex, pool) {
  const target = signInTarget(account.journey, account.organisationId)
  await signInAt(page, { email: account.email, password: account.password, ...target })

  const ctx = journeyContext(account.journey, account.organisationId, pool)
  await journey.setup?.(page, ctx)

  for (const step of journey.steps.slice(0, stepIndex + 1)) {
    await step.enter(page, ctx)
    await step.ready(page, ctx).first().waitFor({ timeout: 30_000 })
    await step.verify?.(page, ctx)
    const notOffered = await step.offered?.(page, ctx)
    if (notOffered) {
      return notOffered
    }
  }

  return null
}

async function auditStep(account, journey, stepIndex, profile, pool, results, proxy) {
  const step = journey.steps[stepIndex]
  const port = nextDebugPort++
  const context = await chromium.launchPersistentContext('', {
    headless: true,
    args: [`--remote-debugging-port=${port}`, '--ignore-certificate-errors'],
    proxy,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true
  })

  try {
    const page = context.pages()[0] ?? (await context.newPage())
    const notOffered = await progressToStep(page, account, journey, stepIndex, pool)
    const name = `${account.type}-${step.name}`

    if (notOffered) {
      console.log(`  [${profile.name}] ${name} SKIPPED: ${notOffered}`)
      results.push({ profile: profile.name, name, url: page.url(), score: null, skipped: notOffered })
      return
    }

    const stepDir = path.join(RESULTS_DIR, profile.name, name)
    await fs.mkdir(stepDir, { recursive: true })
    console.log(`  [${profile.name}] auditing ${page.url()}`)
    const result = await playAudit({
      page,
      port,
      thresholds: profile.opts.thresholds,
      opts: profile.opts.opts,
      reports: { formats: { html: true, json: true }, name: 'report', directory: stepDir }
    })
    const score = result?.lhr?.categories?.performance?.score ?? null
    results.push({ profile: profile.name, name, url: page.url(), score })
    console.log(`  [${profile.name}] → performance score: ${score == null ? 'n/a' : (score * 100).toFixed(0)}`)
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    console.error(`  [${profile.name}] ${account.type}-${step.name} FAILED: ${message}`)
    results.push({ profile: profile.name, name: `${account.type}-${step.name}`, score: null, error: message })
  } finally {
    await context.close().catch(() => {})
  }
}

async function main() {
  const url = baseUrl()
  const floor = performanceFloor()
  const year = obligationYear()
  const accounts = configuredAccounts()
  const proxy = process.env.HTTP_PROXY ? { server: process.env.HTTP_PROXY } : undefined
  const snapshotPath = path.join(RESULTS_DIR, 'local-prn-snapshot.json')

  await fs.rm(RESULTS_DIR, { recursive: true, force: true })
  await fs.mkdir(RESULTS_DIR, { recursive: true })
  console.log(`PRN and obligations Lighthouse run against ${url} for ${year} (floor ${floor})`)

  const seeded = localPrnDataEnabled()
  if (seeded) {
    const count = prnsPerAccount()
    console.log(`LOCAL: adding ${count} PRNs and PERNs awaiting acceptance to each account`)
    await prepareLocalPrns(accounts, { count, year, snapshotPath })
  }

  const results = []
  try {
    for (const account of accounts) {
      const pool = await PrnPool.load(account.organisationId, year)
      console.log(`[${account.label}] ${pool.remaining} PRNs and PERNs awaiting acceptance to use`)

      for (const journey of journeys) {
        for (const [stepIndex, step] of journey.steps.entries()) {
          if (step.download) {
            console.log(`[${account.label}] ${step.name}: a file download, timed by the load test, not audited`)
            continue
          }
          console.log(`[${account.label}] ${journey.name} → ${step.name}`)
          for (const profile of auditProfiles) {
            await auditStep(account, journey, stepIndex, profile, pool, results, proxy)
          }
        }
      }
    }
  } finally {
    if (seeded) {
      const restored = await restoreLocalPrns(snapshotPath)
      console.log(`LOCAL: generated notes deleted and ${restored} existing notes restored`)
    }
  }

  await fs.writeFile(path.join(RESULTS_DIR, 'results.json'), JSON.stringify(results, null, 2))
  await writeIndex(RESULTS_DIR)

  const failed = results.filter((result) => result.error)
  const belowFloor = results.filter((result) => result.score != null && result.score < floor)
  const skipped = results.filter((result) => result.skipped)

  for (const result of skipped) {
    console.log(`SKIPPED [${result.profile}] ${result.name}: ${result.skipped}`)
  }
  for (const result of failed) {
    console.error(`FAILED [${result.profile}] ${result.name}: ${result.error}`)
  }
  for (const result of belowFloor) {
    console.error(`BELOW FLOOR [${result.profile}] ${result.name}: ${(result.score * 100).toFixed(0)}`)
  }

  const audited = results.length - failed.length - skipped.length
  console.log(`${audited} audit(s), ${skipped.length} skipped, ${failed.length} failed, ${belowFloor.length} below the ${floor} floor`)
  if (failed.length > 0 || belowFloor.length > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
