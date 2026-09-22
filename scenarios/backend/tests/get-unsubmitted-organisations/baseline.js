import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, headers, httpParams, thinkTime } from '../../lib/config.js';
import { buildHandleSummary } from '../../lib/summary.js';

export const options = {
  scenarios: {
    baseline: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds: {
    checks: ['rate==1.0'],
  },
};

export default function () {
  const url = `${baseUrl()}/compliance-declarations/unsubmitted?obligationYear=2026`;

  const res = http.get(url, { headers: headers(), ...httpParams });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has unsubmittedOrganisations': (r) => r.json('unsubmittedOrganisations') !== undefined,
  });

  thinkTime();
}

export const handleSummary = buildHandleSummary(
  __ENV.RESULTS_DIR || 'results/get-unsubmitted-organisations/baseline',
);
