import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, headers, httpParams, pickOrgId, thinkTime } from '../../lib/config.js';
import { buildHandleSummary } from '../../lib/summary.js';

export const options = {
  scenarios: {
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '30s', target: 20 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const orgId = pickOrgId();
  const url = `${baseUrl()}/organisations/${orgId}/obligations?obligationYear=2026`;

  const res = http.get(url, { headers: headers(), ...httpParams });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response under 2s': (r) => r.timings.duration < 2000,
    'has obligations': (r) => r.json('obligations') !== undefined,
  });

  thinkTime();
}

export const handleSummary = buildHandleSummary(
  __ENV.RESULTS_DIR || 'results/get-obligations/load',
);
