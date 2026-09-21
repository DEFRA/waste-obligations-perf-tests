import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, headers, httpParams } from '../../lib/config.js';
import { SCENARIO_B, READ_DURATION_OVERRIDES, constantThresholds } from '../../lib/load-model.js';
import { buildHandleSummary } from '../../lib/summary.js';

export const options = {
  scenarios: { load: { ...SCENARIO_B, ...READ_DURATION_OVERRIDES.scenarioB } },
  thresholds: constantThresholds(SCENARIO_B.rate),
};

export default function () {
  const query = [
    'obligationYear=2026',
    'country=GB-ENG,GB-WLS',
    'registrationType=DirectProducer,ComplianceScheme',
    'sort=Name',
    'pageSize=100',
    'page=1',
  ].join('&');
  const url = `${baseUrl()}/compliance-declarations/unsubmitted?${query}`;

  const res = http.get(url, { headers: headers(), ...httpParams });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response under 2s': (r) => r.timings.duration < 2000,
    'has unsubmittedOrganisations': (r) => r.json('unsubmittedOrganisations') !== undefined,
  });
}

export const handleSummary = buildHandleSummary(
  __ENV.RESULTS_DIR || 'results/get-unsubmitted-organisations/scenario-b-stress',
);
