import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, headers, httpParams, pickOrgId, thinkTime } from '../../lib/config.js';
import { createDeclarationBody, patchDeclarationBody } from '../../lib/payloads.js';
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
  const base = baseUrl();

  const postRes = http.post(
    `${base}/organisations/${orgId}/compliance-declarations`,
    JSON.stringify(createDeclarationBody(orgId)),
    { headers: headers(), ...httpParams },
  );
  const postOk = check(postRes, {
    'POST status is 201': (r) => r.status === 201,
    'POST under 2s': (r) => r.timings.duration < 2000,
  });
  thinkTime();
  if (!postOk) return;

  const declarationId = postRes.json('id');

  const patchRes = http.patch(
    `${base}/organisations/${orgId}/compliance-declarations/${declarationId}`,
    JSON.stringify(patchDeclarationBody()),
    { headers: headers(), ...httpParams },
  );
  check(patchRes, {
    'PATCH status is 200': (r) => r.status === 200,
    'PATCH under 2s': (r) => r.timings.duration < 2000,
  });
  thinkTime();

  const getRes = http.get(
    `${base}/organisations/${orgId}/compliance-declarations/${declarationId}`,
    { headers: headers(), ...httpParams },
  );
  check(getRes, {
    'GET status is 200': (r) => r.status === 200,
    'GET under 2s': (r) => r.timings.duration < 2000,
    'GET id matches declarationId': (r) => r.json('id') === declarationId,
  });
  thinkTime();
}

export const handleSummary = buildHandleSummary(
  __ENV.RESULTS_DIR || 'results/create-compliance-declaration/load',
);
