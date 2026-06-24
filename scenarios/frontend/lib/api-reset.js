// Pre-run reset: PATCH-to-Cancelled every non-Cancelled compliance declaration
// for the target org/year so the Lighthouse flow can submit a fresh one each
// run without the backend rejecting the resubmit with a 502.
//
// Mirrors waste-obligations-journey-tests/utils/waste-obligations-api.js —
// same backend endpoints, same basic-auth, same payload shape — but trimmed
// to PATCH-to-Cancelled (no DELETE, which would need JOURNEY_USER creds).

import { request as playwrightRequest } from '@playwright/test'

import { backendBaseUrl } from './config.js'

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} must be set in the environment`)
  }
  return value
}

function basicAuthHeader() {
  const token = Buffer.from(
    `${requireEnv('WASTE_OBLIGATION_USERNAME')}:${requireEnv('WASTE_OBLIGATION_PASSWORD')}`
  ).toString('base64')
  return `Basic ${token}`
}

function submitterUser() {
  return {
    name: 'perf-test-submitter',
    id: requireEnv('WASTE_OBLIGATION_SUBMITTER_ID'),
    email: requireEnv('WASTE_OBLIGATION_SUBMITTER_EMAIL'),
  }
}

function buildHeaders() {
  const result = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: basicAuthHeader(),
  }
  const apiKey = process.env.X_API_KEY
  if (apiKey) {
    result['x-api-key'] = apiKey
  }
  return result
}

async function listCancellableDeclarations(request, base, orgId, year) {
  const response = await request.get(
    `${base}/organisations/${orgId}/compliance-declarations?obligationYear=${year}`,
    { headers: buildHeaders() }
  )
  if (!response.ok()) {
    throw new Error(
      `GET compliance-declarations failed: ${response.status()} ${await response.text()}`
    )
  }
  const body = await response.json()
  if (!Array.isArray(body.complianceDeclarations)) {
    throw new Error(
      `GET compliance-declarations returned unexpected shape: ${JSON.stringify(body).slice(0, 500)}`
    )
  }
  const statusCounts = body.complianceDeclarations.reduce((acc, d) => {
    acc[d.status] = (acc[d.status] || 0) + 1
    return acc
  }, {})
  console.log(
    `  list returned ${body.complianceDeclarations.length} declaration(s): ${JSON.stringify(statusCounts)}`
  )
  return body.complianceDeclarations.filter((d) => d.status !== 'Cancelled')
}

async function cancelDeclaration(request, base, orgId, declarationId) {
  const response = await request.patch(
    `${base}/organisations/${orgId}/compliance-declarations/${declarationId}`,
    {
      headers: buildHeaders(),
      data: {
        status: 'Cancelled',
        user: submitterUser(),
        reason: 'Lighthouse run reset',
      },
    }
  )
  if (!response.ok()) {
    throw new Error(
      `PATCH compliance-declaration ${declarationId} to Cancelled failed: ${response.status()} ${await response.text()}`
    )
  }
}

export async function cancelExistingDeclarations(orgId, year) {
  // Pass full URLs (not Playwright's baseURL) so a path-prefixed override like
  // https://gateway/waste-obligations is preserved — baseURL resolution drops
  // any path component when the request path starts with '/'.
  const base = backendBaseUrl().replace(/\/$/, '')
  const request = await playwrightRequest.newContext({
    ignoreHTTPSErrors: true,
  })
  try {
    const declarations = await listCancellableDeclarations(
      request,
      base,
      orgId,
      year
    )
    for (const d of declarations) {
      await cancelDeclaration(request, base, orgId, d.id)
    }
    return declarations.length
  } finally {
    await request.dispose()
  }
}
