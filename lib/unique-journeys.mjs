export async function runUniqueJourneys(accounts, configuration, startAtMilliseconds, runJourney, clock = {}) {
  const now = clock.now ?? Date.now
  const sleep = clock.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const interval = 60000 / configuration.journeyRatePerMinute
  const end = startAtMilliseconds + configuration.measuredDurationMilliseconds
  const pending = new Set()
  const users = []
  let nextAccount = 0
  let missedSlots = 0
  let attemptedSlots = 0
  let lastActualLaunch = -Infinity
  const limit = Math.min(accounts.length, configuration.journeyLimit)
  for (let slot = 0; startAtMilliseconds + slot * interval < end && nextAccount < limit; slot++) {
    const scheduled = startAtMilliseconds + slot * interval
    const deadline = Math.min(end, scheduled + interval)
    const earliestLaunch = Math.max(scheduled, lastActualLaunch + interval)
    while (now() < earliestLaunch && earliestLaunch < deadline) await sleep(earliestLaunch - now())
    attemptedSlots++
    if (earliestLaunch >= deadline || now() >= deadline || pending.size >= configuration.journeyConcurrency) {
      missedSlots++
      continue
    }
    const index = nextAccount++
    lastActualLaunch = now()
    const account = accounts[index]
    let pendingJourney
    pendingJourney = (async () => runJourney(account, index))()
      .then(result => { users.push(result) })
      .catch(error => { users.push({ organisationId: account.allocation.organisationId, journeyFailed: true, fatalError: error.message, timings: [] }) })
      .finally(() => pending.delete(pendingJourney))
    pending.add(pendingJourney)
  }
  await Promise.all(pending)
  return { users, attemptedSlots, missedSlots, uniqueOrganisationsStarted: nextAccount,
    remainingPoolCount: accounts.length - nextAccount, poolExhausted: nextAccount === accounts.length,
    journeyLimitReached: nextAccount === limit, startedAtUtc: new Date(startAtMilliseconds).toISOString(),
    measuredEndAtUtc: new Date(end).toISOString() }
}
