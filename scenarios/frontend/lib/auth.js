import { expect } from '@playwright/test'

import { frontendUrl, obligationYear } from './config.js'

// Navigate directly to the CSOC About page; an unauthenticated request
// triggers the B2C redirect chain that lands on the login form. After login
// the frontend returns the browser to the same deep URL, so the audit loop
// can pick up from direct-producer-about without an extra dashboard hop.
//
// The B2C flow can resolve in two ways — straight to the login form or to a
// transient error page with a "Sign in" link — so we wait for the redirect
// chain to settle, branch on the URL, then fill the credentials. Mirrors
// waste-obligations-journey-tests/auth/auth.setup.js.
function journeyStart(journey, orgId, year) {
  if (journey === 'cso') {
    return {
      path: `/cso/${orgId}/compliance/statement?year=${year}`,
      heading: /About your \d{4} statement of compliance/i
    }
  }

  return {
    path: `/producer/${orgId}/compliance/certificate?year=${year}`,
    heading: /About your \d{4} certificate of compliance/i
  }
}

export async function signInAs(page, { email, password, orgId, journey = 'producer' } = {}) {
  if (!email || !password) throw new Error('signInAs: email and password are required')
  if (!orgId) throw new Error('signInAs: orgId is required')

  const year = obligationYear()
  const start = journeyStart(journey, orgId, year)
  await page.goto(frontendUrl(start.path), {
    timeout: 60_000,
  })
  await page.waitForLoadState('networkidle')

  if (page.url().includes('error')) {
    await page.getByRole('link', { name: /sign in/i }).click()
  }

  await page.getByLabel(/email/i).fill(email)
  await page.getByLabel(/password/i).fill(password)
  await page.getByRole('button', { name: /sign in|continue|next/i }).click()

  await expect(
    page.getByRole('heading', { name: start.heading })
  ).toBeVisible({ timeout: 60_000 })
}

export async function signIn(page) {
  const email = process.env.EPR_USER_EMAIL
  const password = process.env.EPR_USER_PASSWORD
  const orgId = process.env.EPR_ORG_ID
  if (!email || !password) {
    throw new Error('EPR_USER_EMAIL and EPR_USER_PASSWORD must be set in the environment')
  }
  if (!orgId) {
    throw new Error('EPR_ORG_ID must be set in the environment')
  }
  return signInAs(page, { email, password, orgId })
}
