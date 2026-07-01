import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, headers, httpParams, pickOrgId } from '../../lib/config.js';
import { createDeclarationBody, patchDeclarationBody } from '../../lib/payloads.js';
import { SPIKE, WRITE_VU_OVERRIDES, spikeThresholds } from '../../lib/load-model.js';
import { buildHandleSummary } from '../../lib/summary.js';

export const options = {
  scenarios: { load: { ...SPIKE, ...WRITE_VU_OVERRIDES.spike } },
  thresholds: spikeThresholds(1000),
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
  });
  if (!postOk) return;

  const declarationId = postRes.json('id');

  const patchRes = http.patch(
    `${base}/organisations/${orgId}/compliance-declarations/${declarationId}`,
    JSON.stringify(patchDeclarationBody()),
    { headers: headers(), ...httpParams },
  );
  check(patchRes, {
    'PATCH status is 200': (r) => r.status === 200,
  });

  const getRes = http.get(
    `${base}/organisations/${orgId}/compliance-declarations/${declarationId}`,
    { headers: headers(), ...httpParams },
  );
  check(getRes, {
    'GET status is 200': (r) => r.status === 200,
    'GET id matches declarationId': (r) => r.json('id') === declarationId,
  });
}

export const handleSummary = buildHandleSummary(
  __ENV.RESULTS_DIR || 'results/create-compliance-declaration/spike',
);
