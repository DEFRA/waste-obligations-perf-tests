// The Accept & Reject PRNs and Manage Obligations pages as timed journeys, for
// both Lighthouse and the browser load test. A journey has an untimed `setup`
// (claiming notes, reaching the page a timed step starts from) and ordered
// `steps`. Each step's `enter` reaches the page, `ready` is the locator that
// shows it rendered, `verify` checks what the page must show, and `offered`
// (optional steps only) says whether the page applies today.
//
// Selectors follow waste-obligations-journey-tests/pages/* and the frontend's
// English content; keep them in step with those.

import { frontendUrl, obligationYear } from './config.js'

const MATERIAL_LINK = /\/obligations\/(aluminium|glass|paper|plastic|steel|wood)(\?|$)/
const MAX_LIST_PAGES = 20

// The producer and compliance scheme routes differ only by their prefix.
export function accountPaths(journey, organisationId) {
  const base = journey === 'cso' ? `/cso/${organisationId}` : `/producer/${organisationId}`

  return {
    obligationsHome: (year) => `${base}/obligations?year=${year}`,
    complianceRecord: () => `${base}/obligations/compliance-record`,
    prnsCsv: () => `${base}/obligations/compliance-record/prns.csv`,
    prns: (year, query = {}) =>
      `${base}/prns?${new URLSearchParams({ year: String(year), ...query })}`,
    prn: (prnId, year) => `${base}/prns/${prnId}?year=${year}`,
    chooseYear: (prnId, year) => `${base}/prns/${prnId}/choose-year?year=${year}`
  }
}

function heading(page, name) {
  return page.getByRole('heading', { name })
}

async function selectAndWait(page, selector, value, param) {
  await Promise.all([
    page.waitForURL((url) => url.searchParams.get(param) === value, { waitUntil: 'load' }),
    page.locator(selector).selectOption(value)
  ])
}

async function clickAndWait(page, locator) {
  const current = page.url()
  await Promise.all([
    page.waitForURL((url) => url.toString() !== current, { waitUntil: 'load' }),
    locator.click()
  ])
}

// The notes listed on the current list page, by number.
async function listedNumbers(page) {
  return page
    .locator('table.app-prns-table tbody tr')
    .evaluateAll((rows) =>
      rows.map((row) => row.querySelector('td a')?.textContent?.trim()).filter(Boolean)
    )
}

const obligationsJourney = {
  name: 'manage-obligations',
  steps: [
    {
      name: 'obligations-home',
      enter: (page, ctx) => page.goto(frontendUrl(ctx.paths.obligationsHome(ctx.year))),
      ready: (page, ctx) => heading(page, new RegExp(`^Manage your ${ctx.year} recycling obligations`, 'i')),
      // The CSoC tile: one of the submit, view, resubmit or missed-deadline cards.
      verify: async (page) => {
        const tile = heading(
          page,
          /(submit|view|resubmit) your (certificate|statement) of compliance|missed the (certificate|statement) of compliance deadline/i
        )
        await tile.first().waitFor({ timeout: 10_000 })
      }
    },
    {
      name: 'obligations-material',
      enter: async (page) => {
        const links = page.locator('table a[href*="/obligations/"]')
        const hrefs = await links.evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href')))
        const index = hrefs.findIndex((href) => MATERIAL_LINK.test(href ?? ''))
        if (index === -1) {
          throw new Error('No material calculation link in the obligations table')
        }
        await clickAndWait(page, links.nth(index))
      },
      ready: (page) => heading(page, /^Your \d{4} recycling obligation for /i)
    },
    {
      name: 'obligations-compliance-record',
      enter: (page, ctx) => page.goto(frontendUrl(ctx.paths.complianceRecord())),
      ready: (page) => heading(page, /^Your (certificate|statement) of compliance record for \d{4}/i)
    },
    {
      name: 'obligations-future-year',
      optional: true,
      enter: (page, ctx) => page.goto(frontendUrl(ctx.paths.obligationsHome(ctx.year + 1))),
      ready: (page) => heading(page, /^Manage your \d{4} recycling obligations/i),
      offered: async (page, ctx) =>
        (await heading(page, new RegExp(`^Manage your ${ctx.year + 1} recycling obligations`, 'i')).count()) > 0
          ? null
          : `${ctx.year + 1} is offered only from 1 December to 31 January; the page showed the current year`
    }
  ]
}

const listJourney = {
  name: 'prns-list',
  steps: [
    {
      name: 'prns-list',
      enter: (page, ctx) => page.goto(frontendUrl(ctx.paths.prns(ctx.year))),
      ready: (page) => heading(page, /^Accept or reject PRNs and PERNs/i)
    },
    {
      name: 'prns-list-filter',
      enter: (page) => selectAndWait(page, '#filter', 'Plastic', 'material'),
      ready: (page) => heading(page, /^Accept or reject PRNs and PERNs/i)
    },
    {
      name: 'prns-list-sort',
      enter: (page) => selectAndWait(page, '#sort', 'TonnageDescending', 'sort'),
      ready: (page) => heading(page, /^Accept or reject PRNs and PERNs/i)
    },
    {
      // A file download, not a page: timed as one request with the
      // signed-in session. With no notes for the record year the frontend
      // shows a page saying so instead of the file.
      name: 'prns-csv-download',
      download: true,
      fetch: async (page, ctx) => {
        const response = await page.request.get(frontendUrl(ctx.paths.prnsCsv()))
        const type = response.headers()['content-type'] ?? ''
        const body = await response.text()

        if (response.status() !== 200) {
          throw new Error(`CSV download returned ${response.status()}`)
        }
        if (!type.includes('text/csv') && !body.includes('Download a list of all PRNs and PERNs')) {
          throw new Error(`CSV download returned ${type} that is neither the CSV nor the empty page`)
        }

        return { contentType: type, bytes: body.length }
      }
    }
  ]
}

const acceptJourney = {
  name: 'accept-prn',
  mutates: true,
  setup: async (page, ctx) => {
    ctx.prn = ctx.pool.claim()
  },
  steps: [
    {
      name: 'prn-awaiting-acceptance',
      enter: (page, ctx) => page.goto(frontendUrl(ctx.paths.prn(ctx.prn.id, ctx.year))),
      ready: (page) => heading(page, /^Packaging recycling note$/i)
    },
    {
      name: 'prn-confirm-accept',
      enter: (page, ctx) =>
        clickAndWait(page, page.getByRole('button', { name: `Accept this ${ctx.prn.type}`, exact: true })),
      ready: (page) => heading(page, /^Are you sure you want to accept this (PRN|PERN)/i)
    },
    {
      name: 'prn-accepted-confirmation',
      enter: (page) => clickAndWait(page, page.getByRole('button', { name: 'Yes, accept', exact: true })),
      ready: (page) => page.getByText(/You accepted this (PRN|PERN) towards/i).first()
    }
  ]
}

const rejectJourney = {
  name: 'reject-prn',
  mutates: true,
  setup: async (page, ctx) => {
    ctx.prn = ctx.pool.claim()
    await page.goto(frontendUrl(ctx.paths.prn(ctx.prn.id, ctx.year)))
    await heading(page, /^Packaging recycling note$/i).waitFor({ timeout: 30_000 })
  },
  steps: [
    {
      name: 'prn-confirm-reject',
      enter: (page, ctx) =>
        clickAndWait(page, page.getByRole('button', { name: `Reject this ${ctx.prn.type}`, exact: true })),
      ready: (page) => heading(page, /^Are you sure you want to reject this (PRN|PERN)\?/i)
    },
    {
      name: 'prn-rejected-confirmation',
      enter: (page) => clickAndWait(page, page.getByRole('button', { name: 'Yes, reject', exact: true })),
      ready: (page) => page.getByText(/You have rejected this (PRN|PERN)\./i).first()
    }
  ]
}

const multiSelectJourney = {
  name: 'accept-selected-prns',
  mutates: true,
  // Tick two notes on one list page that no other journey has claimed.
  setup: async (page, ctx) => {
    for (let listPage = 1; listPage <= MAX_LIST_PAGES; listPage++) {
      await page.goto(frontendUrl(ctx.paths.prns(ctx.year, { page: String(listPage) })))
      await heading(page, /^Accept or reject PRNs and PERNs/i).waitFor({ timeout: 30_000 })
      const numbers = await listedNumbers(page)

      if (numbers.length === 0) {
        break
      }

      const claimed = ctx.pool.claimFromNumbers(numbers, 2)
      if (claimed.length === 2) {
        ctx.selected = claimed
        for (const prn of claimed) {
          await page.getByRole('checkbox', { name: `Select ${prn.number}` }).check()
        }
        return
      }
      ctx.pool.release(claimed)
    }

    throw new Error('No list page has two unclaimed PRNs or PERNs awaiting acceptance')
  },
  steps: [
    {
      name: 'prns-check-selection',
      enter: (page) =>
        clickAndWait(page, page.getByRole('button', { name: 'Accept selected PRNs and PERNs', exact: true })),
      ready: (page) => heading(page, /^Check your selection before accepting/i)
    },
    {
      name: 'prns-accepted-selection',
      enter: (page) => clickAndWait(page, page.getByRole('button', { name: 'Accept', exact: true })),
      ready: (page) => heading(page, /accepted \d+ PRNs? (and|or) PERNs? towards your \d{4} recycling obligations/i)
    }
  ]
}

const chooseYearJourney = {
  name: 'choose-year-to-accept',
  setup: async (page, ctx) => {
    ctx.prn = ctx.pool.decemberWasteNote()
  },
  steps: [
    {
      name: 'prn-choose-year',
      optional: true,
      enter: async (page, ctx) => {
        if (ctx.prn) {
          await page.goto(frontendUrl(ctx.paths.chooseYear(ctx.prn.id, ctx.year)))
        }
      },
      // Outside the December window the frontend sends the page on to Are you sure?.
      ready: (page) =>
        heading(page, /^Which year.s recycling obligations do you want to accept this/i)
          .or(heading(page, /^Are you sure you want to accept this/i))
          .or(heading(page, /^Packaging recycling note$/i))
          .or(heading(page, /^Manage your \d{4} recycling obligations/i)),
      offered: async (page, ctx) => {
        if (!ctx.prn) {
          return 'No December waste PRN or PERN awaiting acceptance'
        }
        return (await heading(page, /^Which year.s recycling obligations do you want to accept this/i).count()) > 0
          ? null
          : 'A choice of year is offered only from 1 December to 31 January; the frontend went on to Are you sure?'
      }
    }
  ]
}

// Read-only journeys first, so the pages are measured before notes change.
export const journeys = [
  obligationsJourney,
  listJourney,
  chooseYearJourney,
  acceptJourney,
  rejectJourney,
  multiSelectJourney
]

// The page a session signs in at: the obligations home for the year.
export function signInTarget(journey, organisationId) {
  const year = obligationYear()

  return {
    path: accountPaths(journey, organisationId).obligationsHome(year),
    heading: new RegExp(`^Manage your ${year} recycling obligations`, 'i')
  }
}

export function journeyContext(journey, organisationId, pool) {
  return {
    journey,
    organisationId,
    pool,
    year: obligationYear(),
    paths: accountPaths(journey, organisationId)
  }
}
