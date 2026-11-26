// Runs the PRN and obligations journeys in a signed-in page, timing each step
// as the CSoC load test does: elapsed from the action to the page being ready,
// plus TTFB of the final document, DOMContentLoaded and load.

const READY_TIMEOUT_MS = 30_000

export async function measurePageStep(page, step, ctx) {
  const t0 = Date.now()
  let ttfb = null
  let dcl = null
  let load = null

  const onResponse = (response) => {
    if (response.request().isNavigationRequest() && response.status() < 300 && ttfb === null) {
      ttfb = Math.round(response.request().timing().responseStart)
    }
  }
  const onDCL = () => {
    if (dcl === null) dcl = Date.now() - t0
  }
  const onLoad = () => {
    if (load === null) load = Date.now() - t0
  }

  page.on('response', onResponse)
  page.on('domcontentloaded', onDCL)
  page.on('load', onLoad)

  try {
    await step.enter(page, ctx)
    await step.ready(page, ctx).first().waitFor({ timeout: READY_TIMEOUT_MS })
    const elapsed = Date.now() - t0

    if (step.verify) {
      await step.verify(page, ctx)
    }
    if (step.offered) {
      const reason = await step.offered(page, ctx)
      if (reason) {
        return { elapsed: null, ttfb: null, dcl: null, load: null, passed: true, skipped: reason }
      }
    }
    if (load === null) {
      await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {})
    }

    return { elapsed, ttfb, dcl, load, passed: true }
  } catch (error) {
    return {
      elapsed: Date.now() - t0,
      ttfb,
      dcl,
      load,
      passed: false,
      error: error instanceof Error ? error.message.split('\n')[0] : String(error)
    }
  } finally {
    page.off('response', onResponse)
    page.off('domcontentloaded', onDCL)
    page.off('load', onLoad)
  }
}

export async function measureDownloadStep(page, step, ctx) {
  const t0 = Date.now()

  try {
    const detail = await step.fetch(page, ctx)
    return { elapsed: Date.now() - t0, ttfb: null, dcl: null, load: null, passed: true, ...detail }
  } catch (error) {
    return {
      elapsed: Date.now() - t0,
      ttfb: null,
      dcl: null,
      load: null,
      passed: false,
      error: error instanceof Error ? error.message.split('\n')[0] : String(error)
    }
  }
}

export function measureStep(page, step, ctx) {
  return step.download ? measureDownloadStep(page, step, ctx) : measurePageStep(page, step, ctx)
}

// Runs one journey: its setup, then each step until one fails. Returns a row
// per step, including the steps not reached after a failure. `thinkTime`
// gives the untimed pause before each step, in milliseconds.
export async function runJourney(page, journey, ctx, { thinkTime = () => 0 } = {}) {
  const rows = []

  try {
    await journey.setup?.(page, ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return journey.steps.map((step) => ({
      journey: journey.name,
      step: step.name,
      passed: false,
      error: `Setup failed: ${message}`
    }))
  }

  for (const [index, step] of journey.steps.entries()) {
    const pause = thinkTime()
    if (pause > 0) {
      await new Promise((resolve) => setTimeout(resolve, pause))
    }
    const result = await measureStep(page, step, ctx)
    rows.push({ journey: journey.name, step: step.name, ...result })

    if (!result.passed) {
      for (const notReached of journey.steps.slice(index + 1)) {
        rows.push({
          journey: journey.name,
          step: notReached.name,
          passed: false,
          error: `Not reached: ${step.name} failed`
        })
      }
      break
    }
  }

  return rows
}
