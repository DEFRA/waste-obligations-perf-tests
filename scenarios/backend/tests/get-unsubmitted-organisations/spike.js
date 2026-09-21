import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, headers, httpParams } from '../../lib/config.js';
import { SPIKE, spikeThresholds } from '../../lib/load-model.js';
import { buildHandleSummary } from '../../lib/summary.js';

export const options = {
  scenarios: { load: SPIKE },
  thresholds: spikeThresholds(),
};

export default function () {
  const url = `${baseUrl()}/compliance-declarations/unsubmitted?obligationYear=2026`;

  const res = http.get(url, { headers: headers(), ...httpParams });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has unsubmittedOrganisations': (r) => r.json('unsubmittedOrganisations') !== undefined,
  });
}

export const handleSummary = buildHandleSummary(
  __ENV.RESULTS_DIR || 'results/get-unsubmitted-organisations/spike',
);
