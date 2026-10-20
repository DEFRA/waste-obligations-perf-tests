import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPrnCatalogue, prnConfiguration, readToken, serviceAuth, tokenForm, validObligations } from '../scenarios/backend/lib/prn-obligations.mjs';
import { preparePrnCatalogue } from '../scenarios/backend/lib/prepare-prn-obligations.mjs';
import { summarisePrnRun } from '../scenarios/backend/lib/summarise-prn-obligations.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const registration = (type = 'LARGE_PRODUCER', registrationYear = 2026, status = 'REGISTERED') => ({ type, registrationYear, status });
const organisation = (n, registrations = [registration()]) => ({ id: id(n), registrations });
const baseEnv = { WASTE_ORGANISATIONS_BASE_URL: 'http://localhost:8006', PRN_API_BASE_URL: 'http://localhost:5168', PRN_TEST_OBLIGATION_YEAR: '2026' };

test('catalogue matches sync types/year/status and deduplicates IDs', () => {
  const catalogue = createPrnCatalogue(prnConfiguration(baseEnv), { organisations: [
    organisation(1, [registration(), registration('COMPLIANCE_SCHEME')]),
    organisation(2, [registration('COMPLIANCE_SCHEME')]),
    organisation(3, [registration('SMALL_PRODUCER')]),
    organisation(4, [registration('LARGE_PRODUCER', 2025)]),
    organisation(5, [registration('LARGE_PRODUCER', 2026, 'CANCELLED')]), organisation(1),
  ] });
  assert.deepEqual(catalogue.organisationIds, [id(1), id(2)]);
});

test('500 organisations require 17/minute at 30 minutes and 34/minute at 15 minutes without changing run duration', () => {
  const body = { organisations: Array.from({ length: 500 }, (_, n) => organisation(n + 1)) };
  assert.equal(createPrnCatalogue(prnConfiguration(baseEnv), body).ratePerMinute, 17);
  const faster = createPrnCatalogue(prnConfiguration({ ...baseEnv, PRN_TEST_REFRESH_WINDOW_SECONDS: '900' }), body);
  assert.equal(faster.ratePerMinute, 34);
  assert.equal(faster.durationSeconds, 1800);
  assert.equal(faster.duration, '30m');
});

test('empty or malformed catalogues and unusable settings fail before load starts', () => {
  assert.throws(() => createPrnCatalogue(prnConfiguration(baseEnv), { organisations: [] }), /No eligible/);
  assert.throws(() => createPrnCatalogue(prnConfiguration(baseEnv), { organisations: [{ id: 'not-a-guid', registrations: [registration()] }] }), /invalid ID/);
  assert.throws(() => prnConfiguration({ ...baseEnv, PRN_TEST_REFRESH_WINDOW_SECONDS: '0' }), /positive integer/);
  assert.throws(() => prnConfiguration({ ...baseEnv, PRN_TEST_DURATION: '0m' }), /positive duration/);
  assert.throws(() => prnConfiguration({ ...baseEnv, PRN_TEST_MAX_VUS: '2' }), /at least/);
  assert.throws(() => serviceAuth({ PRN_API_CLIENT_ID: 'id', PRN_API_CLIENT_SECRET: 'secret', PRN_API_TOKEN_URL: 'https://login.example/token' }, 'PRN_API', ['oauth2', 'none'], 'body'), /SCOPE/);
});

test('Azure credentials/scope are form-encoded and 60-second tokens remain cached before renewal', () => {
  const auth = serviceAuth({ PRN_API_CLIENT_ID: 'client', PRN_API_CLIENT_SECRET: 'a&b+c', PRN_API_SCOPE: 'resource/.default', PRN_API_TOKEN_URL: 'https://login.example/token' }, 'PRN_API', ['oauth2', 'none'], 'body');
  const form = new URLSearchParams(tokenForm(auth));
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_secret'), 'a&b+c');
  assert.equal(form.get('scope'), 'resource/.default');
  assert.equal(readToken({ access_token: 'token', expires_in: 60 }, 1000).refreshAt, 55000);
  assert.throws(() => readToken({ access_token: 'token' }), /expires_in/);
});

test('obligation checks accept zero/no obligations but reject another organisation and error bodies', () => {
  assert.equal(validObligations({ obligationData: [], numberOfPrnsAwaitingAcceptance: 0 }, id(1)), true);
  assert.equal(validObligations({ obligationData: [{ organisationId: id(1), materialName: 'Glass', tonnage: 0 }], numberOfPrnsAwaitingAcceptance: 0 }, id(1)), true);
  assert.equal(validObligations({ obligationData: [{ organisationId: id(2), materialName: 'Glass' }], numberOfPrnsAwaitingAcceptance: 0 }, id(1)), false);
  assert.equal(validObligations({ title: 'Internal server error' }, id(1)), false);
});

test('OAuth catalogue preparation writes IDs/rate without credentials or tokens', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'prn-catalogue-test.'));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, headers: request.headers, body });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/token' ? { access_token: 'private-token', expires_in: 60 } : { organisations: [organisation(1), organisation(2)] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const env = { ...baseEnv, WASTE_ORGANISATIONS_BASE_URL: url, WASTE_ORGANISATIONS_TOKEN_URL: `${url}/token`, WASTE_ORGANISATIONS_CLIENT_ID: 'client', WASTE_ORGANISATIONS_CLIENT_SECRET: 'private-secret', WASTE_ORGANISATIONS_SCOPE: 'org/read', PRN_API_AUTH_MODE: 'none' };
  const path = join(directory, 'catalogue.json');
  await preparePrnCatalogue(env, path);
  assert.equal(requests[0].headers.authorization, `Basic ${Buffer.from('client:private-secret').toString('base64')}`);
  assert.equal(new URLSearchParams(requests[0].body).get('scope'), 'org/read');
  assert.equal(requests[1].url, '/organisations');
  assert.equal(requests[1].headers.authorization, 'Bearer private-token');
  const saved = await readFile(path, 'utf8');
  assert.deepEqual(JSON.parse(saved).organisationIds, [id(1), id(2)]);
  assert.doesNotMatch(saved, /private-token|private-secret|Authorization/);
});

test('coverage counts later successful retries once and excludes OAuth from PRN time buckets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'prn-summary-test.'));
  t.after(() => rm(directory, { recursive: true }));
  const point = (metric, value, tags = {}) => ({ type: 'Point', metric, data: { value, tags, time: '2026-10-20T10:00:00Z' } });
  const samples = join(directory, 'samples.json');
  await writeFile(samples, [
    point('prn_organisation_requests', 1, { organisation_id: id(1), outcome: 'failure', status: '500' }),
    point('prn_organisation_requests', 1, { organisation_id: id(2), outcome: 'success', status: '200' }),
    point('prn_organisation_requests', 1, { organisation_id: id(1), outcome: 'success', status: '200' }),
    point('prn_obligation_duration', 100), point('prn_obligation_duration', 200),
    point('http_req_duration', 9999, { endpoint: 'prn_oauth' }),
  ].map(row => JSON.stringify(row)).join('\n'));
  const report = await summarisePrnRun({ organisationIds: [id(1), id(2)], durationSeconds: 1800, refreshWindowSeconds: 1800 }, samples);
  assert.equal(report.attemptedOrganisations, 2);
  assert.equal(report.successfulOrganisations, 2);
  assert.equal(report.totalRequests, 3);
  assert.deepEqual(report.httpStatuses, { 200: 2, 500: 1 });
  assert.equal(report.minutes[0].p95Milliseconds, 200);
  assert.equal(report.minutes[0].failures, 1);
});
