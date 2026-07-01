import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, headers, httpParams } from '../../lib/config.js';
import { SCENARIO_A, READ_DURATION_OVERRIDES, constantThresholds } from '../../lib/load-model.js';
import { buildHandleSummary } from '../../lib/summary.js';

export const options = {
  scenarios: { load: { ...SCENARIO_A, ...READ_DURATION_OVERRIDES.scenarioA } },
  thresholds: constantThresholds(SCENARIO_A.rate),
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
  __ENV.RESULTS_DIR || 'results/search-compliance-declarations/scenario-a-load',
);
