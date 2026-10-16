// Positive sightings accumulate: offset pagination can miss rows while other
// journeys temporarily remove them from the view.
export function eligibleOrganisationIds(rows, allocations, year) {
  const expected = new Set(allocations.map(allocation => allocation.organisationId))
  return [...new Set(rows.filter(row => row && typeof row.organisationId === 'string'
    && row.obligationYear === year && expected.has(row.organisationId)).map(row => row.organisationId))]
}

export function assertEquivalentAllocations(accounts, allocations) {
  const identity = allocation => JSON.stringify([
    allocation.organisationId, allocation.userId, allocation.userIndex,
    allocation.operatorOrganisationId ?? null,
    allocation.registrationType ?? (allocation.operatorOrganisationId ? 'ComplianceScheme' : 'DirectProducer')
  ])
  const actual = accounts.map(account => identity(account.allocation)).sort()
  const expected = allocations.map(identity).sort()
  if (new Set(allocations.map(allocation => allocation.organisationId)).size !== allocations.length
    || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])
    || accounts.some(account => account.type !== (account.allocation.operatorOrganisationId ? 'cso' : 'dp'))) {
    throw new Error('Frontend session allocations do not match the original polling catalogue')
  }
}

export async function runReusableJourneys(accounts, configuration, startAtMilliseconds, runJourney, discovery, clock = {}) {
  const now = clock.now ?? Date.now
  const sleep = clock.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const interval = 60000 / configuration.journeyRatePerMinute
  const end = startAtMilliseconds + configuration.measuredDurationMilliseconds
  const byId = new Map(accounts.map(account => [account.allocation.organisationId, account]))
  const discovered = new Set()
  const started = new Set()
  const quarantined = new Set()
  const busy = new Set()
  const available = []
  const pending = new Set()
  const users = []
  const discoveryErrors = []
  let scan = null
  let nextScan = startAtMilliseconds
  let nextSlot = 0
  let lastLaunch = -Infinity
  let attemptedSlots = 0
  let saturatedSlots = 0
  let dataStarvedSlots = 0
  let timingMissedSlots = 0
  let cyclesStarted = 0
  const observe = ids => {
    for (const id of ids) if (byId.has(id) && !discovered.has(id)) {
      discovered.add(id)
      available.push(id)
    }
  }
  observe(discovery.initialOrganisationIds ?? [])
  try {
    while (now() < end) {
      if (!scan && now() >= nextScan) {
        scan = Promise.resolve().then(() => discovery.read(end)).then(observe)
          .catch(error => {
            const measurementTimeout = now() >= end && (error.name === 'TimeoutError' || error.message === 'Readiness deadline elapsed')
            if (!measurementTimeout) discoveryErrors.push(error.message)
          })
          .finally(() => { scan = null; nextScan = now() + 5000 })
      }
      const scheduled = startAtMilliseconds + nextSlot * interval
      if (scheduled >= end || (configuration.journeyLimit !== null && cyclesStarted >= configuration.journeyLimit)) {
        await sleep(Math.min(100, end - now()))
        continue
      }
      const deadline = Math.min(end, scheduled + interval)
      const earliest = Math.max(scheduled, lastLaunch + interval)
      if (now() < earliest && earliest < deadline) {
        await sleep(Math.min(earliest - now(), scan ? 100 : Math.max(1, nextScan - now())))
        continue
      }
      attemptedSlots++
      nextSlot++
      if (earliest >= deadline || now() >= deadline) { timingMissedSlots++; continue }
      if (pending.size >= configuration.journeyConcurrency) { saturatedSlots++; continue }
      if (!available.length) { dataStarvedSlots++; continue }
      const id = available.shift()
      const account = byId.get(id)
      busy.add(id)
      started.add(id)
      const index = cyclesStarted++
      lastLaunch = now()
      let task
      task = (async () => runJourney(account, index))()
        .catch(error => ({ organisationId: id, journeyFailed: true, fatalError: error.message, timings: [] }))
        .then(result => {
          users.push(result)
          // Recovery after any failure never makes an account reusable.
          if (!result.journeyFailed && !result.fatalError && result.persistedOutcomeStatus === 'Cancelled') available.push(id)
          else quarantined.add(id)
        }).finally(() => { busy.delete(id); pending.delete(task) })
      pending.add(task)
    }
  } finally {
    // read() owns a measurement deadline; no new scan starts after the window.
    if (scan) await scan
    await Promise.all(pending)
  }
  const neverSeenOrganisationIds = [...byId.keys()].filter(id => !discovered.has(id))
  return { users, cyclesStarted, uniqueOrganisationsStarted: started.size, attemptedSlots,
    missedSlots: saturatedSlots + dataStarvedSlots + timingMissedSlots,
    saturatedSlots, dataStarvedSlots, timingMissedSlots, discoveryErrors,
    discoveredOrganisationCount: discovered.size, neverSeenOrganisationCount: neverSeenOrganisationIds.length, neverSeenOrganisationIds,
    quarantinedOrganisationCount: quarantined.size, quarantinedOrganisationIds: [...quarantined], remainingAvailableCount: available.length,
    remainingInFlightCount: busy.size, journeyLimitReached: configuration.journeyLimit !== null && cyclesStarted >= configuration.journeyLimit,
    startedAtUtc: new Date(startAtMilliseconds).toISOString(), measuredEndAtUtc: new Date(end).toISOString() }
}
