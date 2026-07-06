import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, headers, httpParams, pickOrgId } from '../../lib/config.js';
import { SCENARIO_B, READ_DURATION_OVERRIDES, constantThresholds } from '../../lib/load-model.js';
import { buildHandleSummary } from '../../lib/summary.js';

export const options = {
  scenarios: { load: { ...SCENARIO_B, ...READ_DURATION_OVERRIDES.scenarioB } },
  thresholds: constantThresholds(SCENARIO_B.rate),
};

export default function () {
  const orgId = pickOrgId();
  const url = `${baseUrl()}/organisations/${orgId}/compliance-declarations?obligationYear=2026`;

  const res = http.get(url, { headers: headers(), ...httpParams });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response under 2s': (r) => r.timings.duration < 2000,
    'has complianceDeclarations': (r) => r.json('complianceDeclarations') !== undefined,
  });
}

export const handleSummary = buildHandleSummary(
  __ENV.RESULTS_DIR || 'results/get-compliance-declarations/scenario-b-stress',
);
