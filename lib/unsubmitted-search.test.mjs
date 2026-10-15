import test from 'node:test'
import assert from 'node:assert/strict'
import { findUnsubmittedOrganisation } from './unsubmitted-search.mjs'

test('finds the exact scheme ID beyond 100 substring name matches', () => {
  const first = { total: 250, unsubmittedOrganisations: Array.from({ length: 100 }, (_, index) => ({ organisationId: `other-${index}` })) }
  const pages = []
  assert.equal(findUnsubmittedOrganisation(first, 'chosen', page => {
    pages.push(page)
    return { total: 250, unsubmittedOrganisations: page === 2 ? first.unsubmittedOrganisations : [{ organisationId: 'chosen' }] }
  }), true)
  assert.deepEqual(pages, [2, 3])
})

test('absent chosen ID fails after exhausting matches, including an empty page', () => {
  const first = { total: 101, unsubmittedOrganisations: Array.from({ length: 100 }, () => ({ organisationId: 'other' })) }
  assert.equal(findUnsubmittedOrganisation(first, 'chosen', () => ({ total: 101, unsubmittedOrganisations: [] })), false)
  assert.equal(findUnsubmittedOrganisation({ total: 1, unsubmittedOrganisations: [{ organisationId: 'other' }] }, 'chosen', () => { throw new Error('Unexpected next page') }), false)
})
