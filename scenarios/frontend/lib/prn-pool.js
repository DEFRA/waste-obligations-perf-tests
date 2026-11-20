// The PRNs and PERNs awaiting acceptance for one account, read once through the
// Waste Obligations API, from which journeys claim the notes they accept or
// reject. Every virtual user on the account shares the pool, so no two journeys
// change the same note, and a note is never claimed twice in a run.

import { request as playwrightRequest } from '@playwright/test'

import { buildHeaders } from './api-reset.js'
import { backendBaseUrl } from './config.js'

const PAGE_SIZE = 100
const MAX_PAGES = 100

export async function loadAwaitingPrns(organisationId, year) {
  const request = await playwrightRequest.newContext({ ignoreHTTPSErrors: true })
  const prns = []

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const query = new URLSearchParams({
        status: 'AwaitingAcceptance',
        acceptableIntoYear: String(year),
        page: String(page),
        pageSize: String(PAGE_SIZE)
      })
      const response = await request.get(
        `${backendBaseUrl()}/organisations/${organisationId}/prns?${query}`,
        { headers: buildHeaders() }
      )

      if (!response.ok()) {
        throw new Error(
          `GET PRNs for ${organisationId} failed: ${response.status()} ${(await response.text()).slice(0, 300)}`
        )
      }

      const body = await response.json()
      prns.push(...body.prns)

      if (body.prns.length < PAGE_SIZE || prns.length >= body.total) {
        break
      }
    }
  } finally {
    await request.dispose()
  }

  return prns.map((prn) => ({
    id: prn.id,
    number: prn.number,
    type: prn.type,
    decemberWaste: prn.decemberWaste,
    obligationYear: prn.obligationYear
  }))
}

export class PrnPool {
  constructor(organisationId, prns) {
    this.organisationId = organisationId
    // December waste can offer a choice of year, which sends Accept to the
    // Choose a year page instead of Are you sure?, so accept and reject
    // journeys use the other notes and the Choose a year page uses these.
    this.available = prns.filter((prn) => !prn.decemberWaste)
    this.decemberWaste = prns.filter((prn) => prn.decemberWaste)
    this.claimedCount = 0
  }

  static async load(organisationId, year) {
    return new PrnPool(organisationId, await loadAwaitingPrns(organisationId, year))
  }

  get remaining() {
    return this.available.length
  }

  claim() {
    const prn = this.available.shift()

    if (!prn) {
      throw new Error(
        `No PRNs or PERNs left awaiting acceptance for ${this.organisationId}: ${this.claimedCount} were used in this run`
      )
    }

    this.claimedCount++
    return prn
  }

  // Claims the first unclaimed notes among those listed on the page, so a
  // multi-select journey ticks notes no other journey is changing.
  claimFromNumbers(numbers, count) {
    const claimed = []

    for (const number of numbers) {
      const index = this.available.findIndex((prn) => prn.number === number)

      if (index !== -1) {
        claimed.push(...this.available.splice(index, 1))
        this.claimedCount++
      }

      if (claimed.length === count) {
        break
      }
    }

    return claimed
  }

  // Returns notes a journey claimed but didn't change.
  release(prns) {
    this.available.unshift(...prns)
    this.claimedCount -= prns.length
  }

  // Read only: the Choose a year page doesn't change the note.
  decemberWasteNote() {
    return this.decemberWaste[0] ?? null
  }
}
