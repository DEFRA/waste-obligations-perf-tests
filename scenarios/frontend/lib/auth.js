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
  if (!orgId) throw new Error('signInAs: orgId is required')

  const start = journeyStart(journey, orgId, obligationYear())
  await signInAt(page, { email, password, path: start.path, heading: start.heading })
}

// Sign in by opening a deep link: the B2C redirect chain lands on the login
// form, and after login the frontend returns the browser to the same page,
// which is ready when the heading shows.
export async function signInAt(page, { email, password, path, heading } = {}) {
  if (!email || !password) throw new Error('signInAt: email and password are required')
  if (!path || !heading) throw new Error('signInAt: path and heading are required')

  await page.goto(frontendUrl(path), {
    timeout: 60_000,
  })
  await page.waitForLoadState('networkidle')

  if (page.url().includes('error')) {
    await page.getByRole('link', { name: /sign in/i }).click()
  }

  // The epr-local-environment B2C mock lists its seeded accounts, each with
  // its own Sign in button, instead of an email and password form.
  if ((await page.getByRole('heading', { name: /^Mock B2C sign-in$/i }).count()) > 0) {
    const account = page.getByRole('row').filter({ hasText: email })
    await account.getByRole('button', { name: /^sign in$/i }).click()
  } else {
    await page.getByLabel(/email/i).fill(email)
    await page.getByLabel(/password/i).fill(password)
    await page.getByRole('button', { name: /sign in|continue|next/i }).click()
  }

  await expect(
    page.getByRole('heading', { name: heading })
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
