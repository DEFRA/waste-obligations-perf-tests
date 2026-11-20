import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PrnPool } from './prn-pool.js'
import { summarise } from '../tests/prn-obligations-load-test.js'

const note = (number, decemberWaste = false) => ({
  id: `id-${number}`,
  number,
  type: 'PRN',
  decemberWaste,
  obligationYear: 2026
})

describe('PrnPool', () => {
  it('never hands the same note to two journeys', () => {
    const pool = new PrnPool('org', [note('A'), note('B')])

    assert.equal(pool.claim().number, 'A')
    assert.equal(pool.claim().number, 'B')
    assert.throws(() => pool.claim(), /No PRNs or PERNs left awaiting acceptance for org: 2 were used/)
  })

  it('keeps December waste out of accept and reject, for the Choose a year page', () => {
    const pool = new PrnPool('org', [note('DW', true), note('A')])

    assert.equal(pool.remaining, 1)
    assert.equal(pool.claim().number, 'A')
    assert.equal(pool.decemberWasteNote().number, 'DW')
  })

  it('claims only listed notes nobody else has, and takes back the ones not used', () => {
    const pool = new PrnPool('org', [note('A'), note('B'), note('C')])
    pool.claim()

    const claimed = pool.claimFromNumbers(['A', 'X', 'C'], 2)
    assert.deepEqual(claimed.map((prn) => prn.number), ['C'])

    pool.release(claimed)
    assert.equal(pool.remaining, 2)
    assert.equal(pool.claim().number, 'C')
  })
})

describe('summarise', () => {
  it('reports percentiles per account and step, counting failures and skips apart', () => {
    const rows = [
      ...[100, 200, 300, 400].map((elapsed) => ({ accountType: 'dp', journey: 'j', step: 's', passed: true, elapsed })),
      { accountType: 'dp', journey: 'j', step: 's', passed: false, elapsed: 30_000, error: 'timeout' },
      { accountType: 'dp', journey: 'j', step: 'optional', passed: true, skipped: 'not offered' }
    ]

    const [timed, optional] = summarise(rows)

    assert.deepEqual(
      { count: timed.count, failed: timed.failed, p50: timed.p50, p95: timed.p95, max: timed.max },
      { count: 4, failed: 1, p50: 200, p95: 400, max: 400 }
    )
    assert.deepEqual(
      { count: optional.count, skipped: optional.skipped, skipReason: optional.skipReason, p95: optional.p95 },
      { count: 0, skipped: 1, skipReason: 'not offered', p95: null }
    )
  })
})
