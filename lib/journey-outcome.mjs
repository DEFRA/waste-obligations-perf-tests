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
      return { failed: false, persistedOutcomeStatus, cancelledDeclarations: outcome === 'cancel' ? 1 : 0, error }
    } catch (failure) {
      failed = true
      error = failure.message
    }
  }
  let cancelledDeclarations = 0
  try {
    cancelledDeclarations = await cancel()
    await assertMembership(true)
    return { failed: true, persistedOutcomeStatus: null, cancelledDeclarations, error }
  } catch (failure) {
    return { failed: true, persistedOutcomeStatus: null, cancelledDeclarations,
      error: [error, failure.message].filter(Boolean).join('; ') }
  }
}
