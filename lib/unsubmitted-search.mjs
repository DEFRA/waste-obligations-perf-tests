// Name searches can match numbered scheme prefixes across several pages.
export function findUnsubmittedOrganisation(firstBody, organisationId, readPage) {
  let body = firstBody
  for (let page = 1; page <= 10000; page++) {
    if (!Array.isArray(body?.unsubmittedOrganisations) || !Number.isInteger(body.total)) return false
    if (body.unsubmittedOrganisations.some(row => row.organisationId === organisationId)) return true
    if (body.unsubmittedOrganisations.length === 0 || page * 100 >= body.total) return false
    body = readPage(page + 1)
  }
  return false
}
