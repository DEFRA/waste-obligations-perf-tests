// Pre-run reset: cancels any 'Submitted' compliance declarations for the
// target org/year so the Lighthouse flow can submit a fresh one each run.
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
    id: requireEnv('WASTE_OBLIGATION_SUBMITTER_ID'),
    email: requireEnv('WASTE_OBLIGATION_SUBMITTER_EMAIL'),
  }
}

function buildHeaders() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: basicAuthHeader(),
  }
}

async function listSubmittedDeclarations(request, orgId, year) {
  const response = await request.get(
    `/organisations/${orgId}/compliance-declarations?obligationYear=${year}`,
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
  return body.complianceDeclarations.filter((d) => d.status === 'Submitted')
}

async function cancelDeclaration(request, orgId, declarationId) {
  const response = await request.patch(
    `/organisations/${orgId}/compliance-declarations/${declarationId}`,
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
  const request = await playwrightRequest.newContext({
    baseURL: backendBaseUrl(),
    ignoreHTTPSErrors: true,
  })
  try {
    const declarations = await listSubmittedDeclarations(request, orgId, year)
    for (const d of declarations) {
      await cancelDeclaration(request, orgId, d.id)
    }
    return declarations.length
  } finally {
    await request.dispose()
  }
}
