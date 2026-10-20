import { readUnsubmittedPage } from '../../lib/unsubmitted-performance.js'
import { SPIKE, spikeThresholds } from '../../lib/load-model.js'
import { buildHandleSummary } from '../../lib/summary.js'

export const options = { scenarios: { load: SPIKE }, thresholds: spikeThresholds() }
export default readUnsubmittedPage
export const handleSummary = buildHandleSummary(
  __ENV.RESULTS_DIR || 'results/get-unsubmitted-organisations/spike'
)
