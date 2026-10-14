export async function finaliseCombinedJourney({ failed, outcome, verifySubmitted, assertMembership, complete, cancel }) {
  let persistedOutcomeStatus = null
  let error = null
  if (!failed) {
    try {
      await verifySubmitted()
      await assertMembership(false)
      const completed = await complete(outcome)
      persistedOutcomeStatus = completed.status
      await assertMembership(outcome === 'cancel')
      return { failed: false, persistedOutcomeStatus, cancelledDeclarations: outcome === 'cancel' ? 1 : 0, cleanupCancelledDeclarations: 0, error }
    } catch (failure) {
      failed = true
      error = failure.message
    }
  }
  let cancelledDeclarations = 0
  try {
    cancelledDeclarations = await cancel()
    await assertMembership(true)
    return { failed: true, persistedOutcomeStatus, cancelledDeclarations, cleanupCancelledDeclarations: cancelledDeclarations, error }
  } catch (failure) {
    return { failed: true, persistedOutcomeStatus, cancelledDeclarations, cleanupCancelledDeclarations: cancelledDeclarations,
      error: [error, failure.message].filter(Boolean).join('; ') }
  }
}

export function summariseJourneyOutcomes(users) {
  const succeeded = users.filter(user => !user.journeyFailed && !user.fatalError)
  return {
    accepted: succeeded.filter(user => user.persistedOutcomeStatus === 'Accepted').length,
    cancelled: succeeded.filter(user => user.persistedOutcomeStatus === 'Cancelled').length,
    savedAccepted: users.filter(user => user.persistedOutcomeStatus === 'Accepted').length,
    savedCancelled: users.filter(user => user.persistedOutcomeStatus === 'Cancelled').length,
    failed: users.length - succeeded.length
  }
}
