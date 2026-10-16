export function validUnsubmittedRow(row, year, initialIds, combined = false) {
  if (!row?.organisationId || row.obligationYear !== year || !row.referenceNumber
    || !['DirectProducer', 'ComplianceScheme'].includes(row.registrationType)) return false
  const calculated = typeof row.recyclingObligationsMet === 'boolean'
    && typeof row.obligationCoveragePercentage === 'number' && Number.isFinite(row.obligationCoveragePercentage)
  if (!combined && initialIds.has(row.organisationId)) return calculated
  return (row.recyclingObligationsMet === null || typeof row.recyclingObligationsMet === 'boolean')
    && (row.obligationCoveragePercentage === null || (typeof row.obligationCoveragePercentage === 'number' && Number.isFinite(row.obligationCoveragePercentage)))
}
