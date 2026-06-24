// Environment → frontend base-URL resolution. Targets the CDP-internal
// waste-obligations-frontend host so perf runs hit the same network path the
// backend tests use. EPR_BASE_URL still overrides for environments not in
// the table (e.g. CDP review envs).

const ENV_TO_HOST = {
  dev: 'waste-obligations-frontend.dev.cdp-int.defra.cloud',
  tst1: 'waste-obligations-frontend.tst.cdp-int.defra.cloud',
  'perf-test': 'waste-obligations-frontend.perf-test.cdp-int.defra.cloud',
}

const ENV_TO_BACKEND_HOST = {
  dev: 'waste-obligations.dev.cdp-int.defra.cloud',
  tst1: 'waste-obligations.tst.cdp-int.defra.cloud',
  'perf-test': 'waste-obligations.perf-test.cdp-int.defra.cloud',
}

export function baseUrl() {
  if (process.env.EPR_BASE_URL) {
    return process.env.EPR_BASE_URL.replace(/\/$/, '')
  }
  const env = process.env.ENVIRONMENT
  if (!env) {
    throw new Error('ENVIRONMENT (or EPR_BASE_URL) must be set')
  }
  const host = ENV_TO_HOST[env]
  if (!host) {
    throw new Error(
      `No frontend host known for ENVIRONMENT='${env}'. Set EPR_BASE_URL to override.`
    )
  }
  return `https://${host}`
}

export function backendBaseUrl() {
  if (process.env.EPR_BACKEND_BASE_URL) {
    return process.env.EPR_BACKEND_BASE_URL.replace(/\/$/, '')
  }
  const env = process.env.ENVIRONMENT
  if (!env) {
    throw new Error('ENVIRONMENT (or EPR_BACKEND_BASE_URL) must be set')
  }
  const host = ENV_TO_BACKEND_HOST[env]
  if (!host) {
    throw new Error(
      `No backend host known for ENVIRONMENT='${env}'. Set EPR_BACKEND_BASE_URL to override.`
    )
  }
  return `https://${host}`
}

export function obligationYear() {
  return 2026
}

// Lighthouse desktop configuration. We only run the `performance` category
// to keep audits fast and focused on what this suite exists for. The
// journey-tests has a separate accessibility spec.
export const desktopAuditOpts = {
  port: 9222,
  thresholds: {
    // Set to 0 here; the runner enforces PERFORMANCE_FLOOR itself so we can
    // emit a meaningful exit code + log message instead of letting
    // playwright-lighthouse throw.
    performance: 0,
  },
  opts: {
    onlyCategories: ['performance'],
    formFactor: 'desktop',
    // Lighthouse's navigation mode clears storage before the cold nav by
    // default, which wipes the B2C session signIn() just established. The
    // audit URL then 302s to b2clogin.com and we measure the login page,
    // not the CSOC page. Disable the reset to keep the cookies.
    disableStorageReset: true,
    screenEmulation: {
      mobile: false,
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      disabled: false,
    },
    throttling: {
      // Lighthouse's built-in desktopDense4G preset (RTT 40ms, throughput 10Mbps).
      rttMs: 40,
      throughputKbps: 10 * 1024,
      cpuSlowdownMultiplier: 1,
      requestLatencyMs: 0,
      downloadThroughputKbps: 0,
      uploadThroughputKbps: 0,
    },
  },
}

// Name typed into the "Full name" field on the submission page. Matches the
// value used by waste-obligations-journey-tests/data/csoc.data.js so both
// suites leave the same audit-trail name on submitted declarations.
export const TEST_USER_NAME = 'Test User'

// Ordered CSOC flow. Each step describes how to reach the page from the
// previous step's resting state, plus the heading we expect to see so we
// can confirm we've landed before handing off to Lighthouse.
//
// Selectors are copied from waste-obligations-journey-tests/pages/* — keep
// in sync if those page objects move.
export const csocSteps = [
  {
    name: 'csoc-about',
    // signIn navigates straight to this page, so there's nothing to click —
    // the page is already rendered when the loop starts.
    enter: async () => {},
    expectHeading: /About your \d{4} certificate of compliance/i,
  },
  {
    name: 'csoc-submission',
    // Reached by clicking "Continue" on the About page.
    enter: async (page) => {
      await page.getByRole('button', { name: /^continue$/i }).click()
    },
    expectHeading: /Check and submit your \d{4} certificate of compliance/i,
  },
  {
    name: 'csoc-view',
    // Reached by filling the full-name field and clicking "Confirm and submit"
    // on the submission page. The local frontend lands directly on the view
    // page (no intermediate success page on this path). This is the real
    // backend commit — the pre-run PATCH-to-Cancelled in api-reset.js makes
    // it safe to repeat.
    enter: async (page) => {
      await page.getByLabel(/full name/i).fill(TEST_USER_NAME)
      await page.getByRole('button', { name: /confirm and submit/i }).click()
    },
    expectHeading: /\d{4} certificate of compliance/i,
  },
  {
    name: 'csoc-success',
    // No UI link from the view page leads here, so navigate directly.
    // Lighthouse's playAudit re-navigates cold anyway, so audit score is
    // unaffected by the route taken to land on the URL.
    enter: async (page) => {
      const orgId = process.env.EPR_ORG_ID
      const year = obligationYear()
      await page.goto(
        `/compliance/${orgId}/certificate/success?year=${year}`
      )
    },
    expectHeading: /\d{4} certificate of compliance/i,
  },
]

export const performanceFloor = () => {
  const raw = process.env.PERFORMANCE_FLOOR
  if (!raw) return 0.5
  const n = Number(raw)
  if (Number.isNaN(n) || n < 0 || n > 1) {
    throw new Error(
      `PERFORMANCE_FLOOR must be a number between 0 and 1, got '${raw}'`
    )
  }
  return n
}
