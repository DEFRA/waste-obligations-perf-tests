import { apiOptions, readUnsubmittedPage } from '../../lib/unsubmitted-performance.js'
import { buildHandleSummary } from '../../lib/summary.js'

export const options = apiOptions('scenario-b-stress')
export default readUnsubmittedPage
export const handleSummary = buildHandleSummary(
  __ENV.RESULTS_DIR || 'results/get-unsubmitted-organisations/scenario-b-stress'
)
