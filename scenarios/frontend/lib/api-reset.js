// Declaration cleanup: PATCH-to-Cancelled every non-Cancelled compliance
// declaration for the target org/year. Lighthouse uses this before its flow;
// the browser load test uses it after each generated organisation completes.
//
// Mirrors waste-obligations-journey-tests/utils/waste-obligations-api.js —
// same backend endpoints, same basic-auth and payload shape. The combined
// polling profile also verifies global deletion using the PerformanceTests ACL.

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
  if (response.status() === 404) {
    console.log('  list returned 0 declaration(s): org has no declarations yet')
    return []
  }
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

function cancellationReason(declaration) {
  const party = declaration.organisation?.registrationType === 'ComplianceScheme'
    ? 'Compliance scheme'
    : 'Producer'
  const reasons = [
    'Not signed by correct person',
    'Recycling obligations changed',
    `${party} can meet recycling obligations`,
    `${party} requested to cancel`,
  ]
  return reasons[Math.floor(Math.random() * reasons.length)]
}

async function cancelDeclaration(request, base, orgId, declaration) {
  const response = await request.patch(
    `${base}/organisations/${orgId}/compliance-declarations/${declaration.id}`,
    {
      headers: buildHeaders(),
      data: {
        status: 'Cancelled',
        user: submitterUser(),
        reason: cancellationReason(declaration),
      },
    }
  )
  if (!response.ok()) {
    throw new Error(
      `PATCH compliance-declaration ${declaration.id} to Cancelled failed: ${response.status()} ${await response.text()}`
    )
  }
}

export async function cancelExistingDeclarations(orgId, year, restoration = 'cancel') {
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
      if (restoration === 'delete') {
        const response = await request.delete(`${base}/compliance-declarations/${d.id}`, { headers: buildHeaders() })
        if (response.status() !== 204) throw new Error(`DELETE declaration failed: ${response.status()} ${await response.text()}`)
      } else {
        await cancelDeclaration(request, base, orgId, d)
      }
    }
    return declarations.length
  } finally {
    await request.dispose()
  }
}

export async function verifySubmittedDeclaration(orgId, year) {
  const base = backendBaseUrl().replace(/\/$/, '')
  const request = await playwrightRequest.newContext({ ignoreHTTPSErrors: true })
  try {
    const declarations = await listCancellableDeclarations(request, base, orgId, year)
    if (!declarations.some(declaration => ['Submitted', 'Accepted'].includes(declaration.status))) {
      throw new Error(`No submitted declaration for organisation ${orgId} and year ${year}`)
    }
  } finally {
    await request.dispose()
  }
}

export async function completeSubmittedDeclaration(orgId, year, outcome) {
  if (!['accept', 'cancel'].includes(outcome)) throw new Error('Journey outcome must be accept or cancel')
  const base = backendBaseUrl().replace(/\/$/, '')
  const request = await playwrightRequest.newContext({ ignoreHTTPSErrors: true })
  const status = outcome === 'accept' ? 'Accepted' : 'Cancelled'
  try {
    const declarations = await listCancellableDeclarations(request, base, orgId, year)
    const submitted = declarations.filter(declaration => declaration.status === 'Submitted')
    if (submitted.length !== 1) throw new Error(`Expected one Submitted declaration for ${orgId}, found ${submitted.length}`)
    const response = await request.patch(`${base}/organisations/${orgId}/compliance-declarations/${submitted[0].id}`, {
      headers: buildHeaders(), data: {
        status,
        user: submitterUser(),
        reason: outcome === 'cancel' ? cancellationReason(submitted[0]) : 'Polling performance journey outcome'
      }
    })
    if (!response.ok()) throw new Error(`PATCH declaration to ${status} failed: ${response.status()} ${await response.text()}`)
    const persisted = await request.get(`${base}/organisations/${orgId}/compliance-declarations?obligationYear=${year}`, { headers: buildHeaders() })
    if (!persisted.ok()) throw new Error(`Read persisted ${status} declaration failed: ${persisted.status()}`)
    const body = await persisted.json()
    if (!body.complianceDeclarations?.some(declaration => declaration.id === submitted[0].id && declaration.status === status)) throw new Error(`Declaration did not persist ${status}`)
    return { declarationId: submitted[0].id, status }
  } finally {
    await request.dispose()
  }
}
