export async function finaliseCombinedJourney({ failed, verifySubmitted, assertMembership, complete, cancel }) {
  let persistedOutcomeStatus = null
  let error = null
  if (!failed) {
    try {
      await verifySubmitted()
      await assertMembership(false)
      const completed = await complete('cancel')
      if (completed.status !== 'Cancelled') throw new Error(`Expected saved Cancelled declaration, received ${completed.status}`)
      persistedOutcomeStatus = completed.status
      await assertMembership(true)
      return { failed: false, persistedOutcomeStatus, cancelledDeclarations: 1, cleanupCancelledDeclarations: 0, error }
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
    cancelled: succeeded.filter(user => user.persistedOutcomeStatus === 'Cancelled').length,
    savedCancelled: users.filter(user => user.persistedOutcomeStatus === 'Cancelled').length,
    failed: users.length - succeeded.length
  }
}
