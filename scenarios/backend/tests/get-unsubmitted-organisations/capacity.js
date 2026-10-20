import { readUnsubmittedPage } from '../../lib/unsubmitted-performance.js'
import { READ_CAPACITY, capacityThresholds } from '../../lib/load-model.js'
import { buildHandleSummary } from '../../lib/summary.js'

export const options = { scenarios: { load: READ_CAPACITY }, thresholds: capacityThresholds }
export default readUnsubmittedPage
export const handleSummary = buildHandleSummary(
  __ENV.RESULTS_DIR || 'results/get-unsubmitted-organisations/capacity'
)
