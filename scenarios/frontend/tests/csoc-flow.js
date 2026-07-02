import { chromium, expect } from '@playwright/test'
import { playAudit } from 'playwright-lighthouse'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  auditProfiles,
  baseUrl,
  csocSteps,
  desktopAuditOpts,
  obligationYear,
  performanceFloor,
} from '../lib/config.js'
import { signIn } from '../lib/auth.js'
import { cancelExistingDeclarations } from '../lib/api-reset.js'
import { writeIndex } from '../lib/report-index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.resolve(__dirname, '..', 'results')
const DEBUG_PORT = desktopAuditOpts.port

async function main() {
  if (!process.env.EPR_USER_EMAIL || !process.env.EPR_USER_PASSWORD) {
    throw new Error(
      'EPR_USER_EMAIL and EPR_USER_PASSWORD must be set in the environment'
    )
  }

  const url = baseUrl()
  const floor = performanceFloor()
  const year = obligationYear()
  const orgId = process.env.EPR_ORG_ID
  if (!orgId) {
    throw new Error('EPR_ORG_ID must be set in the environment')
  }

  await fs.rm(RESULTS_DIR, { recursive: true, force: true })
  await fs.mkdir(RESULTS_DIR, { recursive: true })

  console.log(`Lighthouse run against ${url} (floor ${floor})`)

  console.log(`Resetting org ${orgId} declarations for year ${year}...`)
  const cancelledCount = await cancelExistingDeclarations(orgId, year)
  console.log(`Cancelled ${cancelledCount} declaration(s)`)

  const proxy = process.env.HTTP_PROXY
    ? { server: process.env.HTTP_PROXY }
    : undefined

  // Use a persistent context so Playwright and Lighthouse share the SAME
  // browsing context. With launch() + newContext(), Lighthouse opens its
  // audit page in the default context and sees none of the cookies signIn()
  // set — the audit URL then 302s straight to b2clogin.com.
  const context = await chromium.launchPersistentContext('', {
    headless: true,
    args: [
      `--remote-debugging-port=${DEBUG_PORT}`,
      // Local HTTPS dev servers use self-signed certs; Lighthouse drives
      // Chromium via CDP and won't pick up Playwright's ignoreHTTPSErrors.
      '--ignore-certificate-errors',
    ],
    proxy,
    baseURL: url,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  })
  const page = context.pages()[0] ?? (await context.newPage())

  const auditResults = []
  try {
    console.log('Signing in...')
    await signIn(page)

    for (const step of csocSteps) {
      console.log(`Step → ${step.name}`)
      await step.enter(page)
      await expect(
        page.getByRole('heading', { name: step.expectHeading })
      ).toBeVisible({ timeout: 30_000 })

      const targetUrl = page.url()

      // playwright-lighthouse re-navigates to the page's current URL using
      // Lighthouse's cold navigation mode, sharing this Chromium instance via
      // the debug port so the auth cookies persist. We audit once per profile
      // (desktop, mobile) before moving on so the login session is reused.
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
            directory: stepDir,
          },
        })

        const score = result?.lhr?.categories?.performance?.score ?? null
        auditResults.push({ profile: profile.name, name: step.name, url: targetUrl, score })
        console.log(`  [${profile.name}] → performance score: ${score == null ? 'n/a' : (score * 100).toFixed(0)}`)
      }
    }
  } finally {
    await context.close()
  }

  await writeIndex(RESULTS_DIR)

  const failing = auditResults.filter(
    (r) => r.score != null && r.score < floor
  )
  if (failing.length > 0) {
    console.error(
      `Performance floor (${floor}) breached by ${failing.length} audit(s):`
    )
    for (const f of failing) {
      console.error(`  - [${f.profile}] ${f.name}: ${(f.score * 100).toFixed(0)}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`All ${auditResults.length} audit(s) passed the ${floor} floor.`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
