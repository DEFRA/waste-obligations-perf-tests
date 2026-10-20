import http from 'k6/http';
import encoding from 'k6/encoding';
import execution from 'k6/execution';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { buildHandleSummary } from '../../lib/summary.js';
import { readToken, serviceAuth, tokenForm, validObligations } from '../../lib/prn-obligations.mjs';

if (!__ENV.PRN_TEST_CATALOGUE_PATH) throw new Error('Run this scenario through the backend entrypoint to prepare its catalogue');
const catalogue = JSON.parse(open(__ENV.PRN_TEST_CATALOGUE_PATH));
const auth = serviceAuth(__ENV, 'PRN_API', ['oauth2', 'none'], 'body');
const timeout = `${catalogue.requestTimeoutSeconds}s`;
const duration = new Trend('prn_obligation_duration', true);
const failures = new Rate('prn_obligation_failed');
const requests = new Counter('prn_organisation_requests');
const firstPass = new Counter('prn_organisations_attempted');
const authFailures = new Rate('prn_auth_failed');
let token;

export const options = {
  scenarios: {
    prn_obligations: {
      executor: 'constant-arrival-rate', rate: catalogue.ratePerMinute, timeUnit: '1m',
      duration: catalogue.duration, preAllocatedVUs: catalogue.preAllocatedVUs, maxVUs: catalogue.maxVUs,
      gracefulStop: `${catalogue.requestTimeoutSeconds + 5}s`,
    },
  },
  setupTimeout: `${catalogue.requestTimeoutSeconds + 5}s`,
  thresholds: {
    prn_obligation_failed: ['rate==0'],
    prn_auth_failed: ['rate==0'],
    dropped_iterations: ['count==0'],
    ...(catalogue.durationSeconds >= catalogue.refreshWindowSeconds
      ? { prn_organisations_attempted: [`count>=${catalogue.organisationIds.length}`] } : {}),
    ...(catalogue.p95Milliseconds ? { prn_obligation_duration: [`p(95)<${catalogue.p95Milliseconds}`] } : {}),
  },
};

function requestToken() {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (auth.method === 'basic') headers.Authorization = `Basic ${encoding.b64encode(`${auth.clientId}:${auth.clientSecret}`)}`;
  const response = http.post(auth.tokenUrl, tokenForm(auth), {
    headers, timeout, redirects: 0, tags: { endpoint: 'prn_oauth', name: 'PRN OAuth token' },
  });
  let nextToken;
  try {
    if (response.status === 200) nextToken = readToken(response.json());
  } catch { /* Record malformed responses as authentication failures. */ }
  authFailures.add(!nextToken);
  if (!nextToken) execution.test.abort(`PRN OAuth failed (HTTP ${response.status}); response and credentials omitted`);
  return nextToken;
}

export function setup() {
  // One initial token is shared with all VUs. Subsequent renewal is cached per VU.
  if (auth.mode === 'oauth2') return requestToken();
  authFailures.add(false);
  return null;
}

export default function (initialToken) {
  const iteration = execution.scenario.iterationInTest;
  const organisationId = catalogue.organisationIds[iteration % catalogue.organisationIds.length];
  const headers = { Accept: 'application/json', 'X-EPR-ORGANISATION': organisationId };
  if (auth.mode === 'oauth2') {
    token = token || initialToken;
    if (Date.now() >= token.refreshAt) token = requestToken();
    headers.Authorization = `Bearer ${token.accessToken}`;
  }
  if (iteration < catalogue.organisationIds.length) firstPass.add(1);
  const response = http.get(`${catalogue.prnBaseUrl}/api/v1/prn/obligationcalculation/${catalogue.year}`, {
    headers, timeout, redirects: 0, tags: { endpoint: 'prn_obligations', name: 'GET PRN obligation calculation' },
  });
  let body;
  try { body = response.json(); } catch { /* Failed contract checks below retain the HTTP outcome. */ }
  const success = check(response, {
    'PRN returns 200': result => result.status === 200,
    'PRN returns obligations for the requested organisation': () => validObligations(body, organisationId),
  }, { endpoint: 'prn_obligations' });
  duration.add(response.timings.duration);
  failures.add(!success);
  requests.add(1, { organisation_id: organisationId, outcome: success ? 'success' : 'failure', status: String(response.status) });
}

export function handleSummary(data) {
  const report = { ...data };
  delete report.setup_data;
  return buildHandleSummary(__ENV.RESULTS_DIR || 'results/prn-obligations/sustained')(report);
}
