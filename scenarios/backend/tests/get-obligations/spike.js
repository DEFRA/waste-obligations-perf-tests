import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, headers, httpParams, pickOrgId } from '../../lib/config.js';
import { SPIKE, spikeThresholds } from '../../lib/load-model.js';
import { buildHandleSummary } from '../../lib/summary.js';

export const options = {
  scenarios: { load: SPIKE },
  thresholds: spikeThresholds(),
};

export default function () {
  const orgId = pickOrgId();
  const url = `${baseUrl()}/organisations/${orgId}/obligations?obligationYear=2026`;

  const res = http.get(url, { headers: headers(), ...httpParams });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has obligations': (r) => r.json('obligations') !== undefined,
  });
}

export const handleSummary = buildHandleSummary(
  __ENV.RESULTS_DIR || 'results/get-obligations/spike',
);
