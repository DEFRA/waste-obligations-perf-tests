import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, headers, httpParams, pickOrgId } from '../../lib/config.js';
import { READ_CAPACITY, capacityThresholds } from '../../lib/load-model.js';
import { buildHandleSummary } from '../../lib/summary.js';

export const options = {
  scenarios: { load: READ_CAPACITY },
  thresholds: capacityThresholds,
};

export default function () {
  const orgId = pickOrgId();
  const url = `${baseUrl()}/organisations/${orgId}/obligations?obligationYear=2026`;

  const res = http.get(url, { headers: headers(), ...httpParams });

  check(res, {
    'status is 200 or 5xx (observing degradation)': (r) => r.status === 200 || r.status >= 500,
  });
}

export const handleSummary = buildHandleSummary(
  __ENV.RESULTS_DIR || 'results/get-obligations/capacity',
);
