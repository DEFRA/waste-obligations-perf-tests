import assert from 'node:assert/strict'
import test from 'node:test'

import { frontendUrl } from './config.js'

function withBaseUrl(value, action) {
  const previous = process.env.EPR_BASE_URL

  try {
    process.env.EPR_BASE_URL = value
    action()
  } finally {
    if (previous === undefined) {
      delete process.env.EPR_BASE_URL
    } else {
      process.env.EPR_BASE_URL = previous
    }
  }
}

test('frontendUrl preserves a reverse-proxy path prefix', () => {
  withBaseUrl('https://localhost:8015/manage-recycling-obligations', () => {
    assert.equal(
      frontendUrl('/compliance/producer/example/certificate?year=2026'),
      'https://localhost:8015/manage-recycling-obligations/compliance/producer/example/certificate?year=2026'
    )
  })
})

test('frontendUrl preserves direct frontend URLs', () => {
  withBaseUrl('https://localhost:8010', () => {
    assert.equal(
      frontendUrl('/compliance/producer/example/certificate?year=2026'),
      'https://localhost:8010/compliance/producer/example/certificate?year=2026'
    )
  })
})
