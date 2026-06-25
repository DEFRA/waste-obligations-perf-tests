import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, headers, httpParams } from '../../lib/config.js';
import { buildHandleSummary } from '../../lib/summary.js';

export const options = {
  scenarios: {
    load: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 20,
      maxVUs: 50,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    http_reqs: ['rate>=19'],
    iteration_duration: ['p(95)<3000'],
    dropped_iterations: ['count<5'],
  },
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
    'status is 200': (r) => r.status === 200,
    'response under 2s': (r) => r.timings.duration < 2000,
    'has complianceDeclarations': (r) => r.json('complianceDeclarations') !== undefined,
  });
}

export const handleSummary = buildHandleSummary(
  __ENV.RESULTS_DIR || 'results/search-compliance-declarations/load',
);
