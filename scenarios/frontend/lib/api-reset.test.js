import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { cancelExistingDeclarations, verifySubmittedDeclaration } from './api-reset.js'

test('cancellation uses organisation PATCH; deletion uses global DELETE; submission checks actual state', async () => {
  const calls = []
  let status = 'Submitted'
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    calls.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null })
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET') {
      response.end(JSON.stringify({ complianceDeclarations: [{ id: 'declaration-1', status }] }))
    } else {
      response.statusCode = 204
      response.end()
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const overrides = {
    EPR_BACKEND_BASE_URL: `http://127.0.0.1:${server.address().port}/service`,
    WASTE_OBLIGATION_USERNAME: 'test', WASTE_OBLIGATION_PASSWORD: 'test',
    X_API_KEY: '',
    WASTE_OBLIGATION_SUBMITTER_ID: 'test-user', WASTE_OBLIGATION_SUBMITTER_EMAIL: 'test@example.com'
  }
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
  Object.assign(process.env, overrides)
  try {
    await verifySubmittedDeclaration('organisation-1', 2026)
    assert.equal(await cancelExistingDeclarations('organisation-1', 2026), 1)
    const patch = calls.find(call => call.method === 'PATCH')
    assert.equal(patch.url, '/service/organisations/organisation-1/compliance-declarations/declaration-1')
    assert.equal(patch.body.status, 'Cancelled')
    assert.equal(await cancelExistingDeclarations('organisation-1', 2026, 'delete'), 1)
    assert.equal(calls.find(call => call.method === 'DELETE').url, '/service/compliance-declarations/declaration-1')
    assert.ok(calls.filter(call => call.method === 'GET').every(call => call.url === '/service/organisations/organisation-1/compliance-declarations?obligationYear=2026'))
    status = 'Cancelled'
    await assert.rejects(verifySubmittedDeclaration('organisation-1', 2026), /No submitted declaration/)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await new Promise(resolve => server.close(resolve))
  }
})
