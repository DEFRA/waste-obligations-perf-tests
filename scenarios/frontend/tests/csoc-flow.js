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
  lighthouseDebugPort,
  obligationYear,
  performanceFloor
} from '../lib/config.js'
import { signInAs } from '../lib/auth.js'
import { cancelExistingDeclarations } from '../lib/api-reset.js'
import { writeIndex } from '../lib/report-index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.resolve(__dirname, '..', 'results')
const DEBUG_PORT = lighthouseDebugPort
const LIGHTHOUSE_ACCOUNT_TYPES = new Set(['dp', 'cso'])
let nextDebugPort = DEBUG_PORT

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

async function progressToStep(page, account, stepIndex) {
  console.log(`Signing in as ${account.label}...`)
  await signInAs(page, {
    email: account.email,
    password: account.password,
    orgId: account.organisationId,
    journey: account.journey
  })

  for (const step of account.steps.slice(0, stepIndex + 1)) {
    await step.enter(page)
    await expect(
      page.getByRole('heading', { name: step.expectHeading })
    ).toBeVisible({ timeout: 30_000 })
  }

  return page.url()
}

async function auditStep(account, stepIndex, profile, auditResults, proxy, url, year) {
  const port = nextDebugPort++
  const step = account.steps[stepIndex]

  if (step.requiresFreshDeclaration) {
    const cancelledCount = await cancelExistingDeclarations(
      account.organisationId,
      year
    )
    console.log(
      `  [${profile.name}] Cancelled ${cancelledCount} declaration(s) before replaying ${step.name}`
    )
  }

  // Lighthouse owns its CDP connection and can close it at the end of an
  // audit. Do not reuse that browser for the next audit: start a fresh,
  // authenticated browser instead. This also prevents one profile's browser
  // state from leaking into the other profile.
  const context = await chromium.launchPersistentContext('', {
    headless: true,
    args: [
      `--remote-debugging-port=${port}`,
      // Chromium driven by Lighthouse does not inherit Playwright's
      // ignoreHTTPSErrors setting for self-signed local certificates.
      '--ignore-certificate-errors'
    ],
    proxy,
    baseURL: url,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true
  })

  try {
    const page = context.pages()[0] ?? (await context.newPage())
    const targetUrl = await progressToStep(page, account, stepIndex)
    const stepDir = path.join(RESULTS_DIR, profile.name, step.name)
    await fs.mkdir(stepDir, { recursive: true })

    console.log(`  [${profile.name}] auditing ${targetUrl}`)
    const result = await playAudit({
      page,
      port,
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
  } finally {
    await context.close().catch(() => {})
  }
}

async function runFlow(account, auditResults, proxy, url, year) {
  for (const [stepIndex, step] of account.steps.entries()) {
    console.log(`[${account.label}] Step → ${step.name}`)
    for (const profile of auditProfiles) {
      await auditStep(account, stepIndex, profile, auditResults, proxy, url, year)
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

  const auditResults = []
  for (const account of accounts) {
    try {
      await runFlow(account, auditResults, proxy, url, year)
    } finally {
      // Replaying each step in an isolated browser can submit more than one
      // declaration. Clear the account after its audits, including on failure.
      const cancelledCount = await cancelExistingDeclarations(
        account.organisationId,
        year
      )
      console.log(`[${account.label}] Cancelled ${cancelledCount} declaration(s) after audit`)
    }
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
