import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, headers, httpParams } from '../../lib/config.js';
import { CAPACITY, capacityThresholds } from '../../lib/load-model.js';
import { buildHandleSummary } from '../../lib/summary.js';

export const options = {
  scenarios: { load: CAPACITY },
  thresholds: capacityThresholds,
};

export default function () {
  const query = [
    'obligationYear=2026',
    'status=Submitted,Accepted',
    `organisationName=${encodeURIComponent('Org Name')}`,
    'pageSize=20',
    'page=1',
  ].join('&');
  const url = `${baseUrl()}/compliance-declarations?${query}`;

  const res = http.get(url, { headers: headers(), ...httpParams });

  check(res, {
    'status is 200 or 5xx (observing degradation)': (r) => r.status === 200 || r.status >= 500,
  });
}

export const handleSummary = buildHandleSummary(
  __ENV.RESULTS_DIR || 'results/search-compliance-declarations/capacity',
);
