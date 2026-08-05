import { chromium, expect } from '@playwright/test'
import { playAudit } from 'playwright-lighthouse'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  auditProfiles,
  baseUrl,
  csoSteps,
  directProducerSteps,
  desktopAuditOpts,
  obligationYear,
  performanceFloor
} from '../lib/config.js'
import { signInAs } from '../lib/auth.js'
import { cancelExistingDeclarations } from '../lib/api-reset.js'
import { writeIndex } from '../lib/report-index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.resolve(__dirname, '..', 'results')
const DEBUG_PORT = desktopAuditOpts.port
const LIGHTHOUSE_ACCOUNT_TYPES = new Set(['dp', 'cso'])

function requireEnvironmentValue(name) {
  const value = process.env[name]

  if (!value) {
    throw new Error(`${name} must be set in the environment`)
  }

  return value
}

function selectedAccountTypes() {
  const raw = process.env.LIGHTHOUSE_ACCOUNT_TYPES ?? 'dp,cso'
  const accountTypes = raw
    .split(',')
    .map((accountType) => accountType.trim())
    .filter(Boolean)

  if (
    accountTypes.length === 0 ||
    accountTypes.some((accountType) => !LIGHTHOUSE_ACCOUNT_TYPES.has(accountType))
  ) {
    throw new Error(
      `LIGHTHOUSE_ACCOUNT_TYPES must be a comma-separated list of dp and cso, got '${raw}'`
    )
  }

  return new Set(accountTypes)
}

function configuredAccounts() {
  const accountTypes = selectedAccountTypes()
  const accounts = []

  if (accountTypes.has('dp')) {
    accounts.push({
      label: 'Direct Producer',
      email: requireEnvironmentValue('EPR_USER_EMAIL'),
      password: requireEnvironmentValue('EPR_USER_PASSWORD'),
      organisationId: requireEnvironmentValue('EPR_ORG_ID'),
      journey: 'producer',
      steps: directProducerSteps
    })
  }

  if (accountTypes.has('cso')) {
    accounts.push({
      label: 'Compliance Scheme Officer',
      email: requireEnvironmentValue('EPR_CSO_USER_EMAIL'),
      password: requireEnvironmentValue('EPR_CSO_USER_PASSWORD'),
      organisationId: requireEnvironmentValue('WASTE_OBLIGATION_CSO_ORG_ID'),
      journey: 'cso',
      steps: csoSteps
    })
  }

  return accounts
}

async function runFlow(page, account, auditResults) {
  console.log(`Signing in as ${account.label}...`)
  await signInAs(page, {
    email: account.email,
    password: account.password,
    orgId: account.organisationId,
    journey: account.journey
  })

  for (const step of account.steps) {
    console.log(`[${account.label}] Step → ${step.name}`)
    await step.enter(page)
    await expect(
      page.getByRole('heading', { name: step.expectHeading })
    ).toBeVisible({ timeout: 30_000 })

    const targetUrl = page.url()

    // playwright-lighthouse re-navigates to the page's current URL using
    // Lighthouse's cold navigation mode, sharing this Chromium instance via
    // the debug port so the authenticated browser context persists.
    for (const profile of auditProfiles) {
      const stepDir = path.join(RESULTS_DIR, profile.name, step.name)
      await fs.mkdir(stepDir, { recursive: true })

      console.log(`  [${profile.name}] auditing ${targetUrl}`)
      const result = await playAudit({
        page,
        port: profile.opts.port,
        thresholds: profile.opts.thresholds,
        opts: profile.opts.opts,
        reports: {
          formats: { html: true, json: true },
          name: 'report',
          directory: stepDir
        }
      })

      const score = result?.lhr?.categories?.performance?.score ?? null
      auditResults.push({
        profile: profile.name,
        name: step.name,
        url: targetUrl,
        score
      })
      console.log(
        `  [${profile.name}] → performance score: ${score == null ? 'n/a' : (score * 100).toFixed(0)}`
      )
    }
  }
}

async function main() {
  const url = baseUrl()
  const floor = performanceFloor()
  const year = obligationYear()
  const accounts = configuredAccounts()

  await fs.rm(RESULTS_DIR, { recursive: true, force: true })
  await fs.mkdir(RESULTS_DIR, { recursive: true })

  console.log(`Lighthouse run against ${url} (floor ${floor})`)
  for (const account of accounts) {
    console.log(
      `Resetting ${account.label} organisation ${account.organisationId} declarations for year ${year}...`
    )
    const cancelledCount = await cancelExistingDeclarations(
      account.organisationId,
      year
    )
    console.log(`[${account.label}] Cancelled ${cancelledCount} declaration(s)`)
  }

  const proxy = process.env.HTTP_PROXY
    ? { server: process.env.HTTP_PROXY }
    : undefined

  // Use a persistent context so Playwright and Lighthouse share the same
  // browsing context. Clear cookies between account types to ensure the
  // second journey genuinely authenticates as the other seeded account.
  const context = await chromium.launchPersistentContext('', {
    headless: true,
    args: [
      `--remote-debugging-port=${DEBUG_PORT}`,
      // Chromium driven by Lighthouse does not inherit Playwright's
      // ignoreHTTPSErrors setting for self-signed local certificates.
      '--ignore-certificate-errors'
    ],
    proxy,
    baseURL: url,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true
  })
  const page = context.pages()[0] ?? (await context.newPage())

  const auditResults = []
  try {
    for (const [accountIndex, account] of accounts.entries()) {
      if (accountIndex > 0) {
        await context.clearCookies()
        await page.goto('about:blank')
      }

      await runFlow(page, account, auditResults)
    }
  } finally {
    await context.close()
  }

  await writeIndex(RESULTS_DIR)

  const failing = auditResults.filter(
    (result) => result.score != null && result.score < floor
  )
  if (failing.length > 0) {
    console.error(
      `Performance floor (${floor}) breached by ${failing.length} audit(s):`
    )
    for (const result of failing) {
      console.error(
        `  - [${result.profile}] ${result.name}: ${(result.score * 100).toFixed(0)}`
      )
    }
    process.exitCode = 1
    return
  }

  console.log(
    `All ${auditResults.length} audit(s) passed the ${floor} floor.`
  )
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
