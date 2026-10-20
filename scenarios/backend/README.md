# waste-obligations-perf-tests — Backend (K6)

## Direct PRN obligations test

`prn-obligations/sustained.js` calls PRN directly, using the same route and organisation header as the waste-obligations background sync:

```http
GET {PRN_API_BASE_URL}/api/v1/prn/obligationcalculation/{PRN_TEST_OBLIGATION_YEAR}
X-EPR-ORGANISATION: {organisationId}
Authorization: Bearer {access_token}
```

Before measurement, the runner reads `GET {WASTE_ORGANISATIONS_BASE_URL}/organisations` once. It selects unique IDs with a `REGISTERED` `LARGE_PRODUCER` or `COMPLIANCE_SCHEME` registration for the selected year. It does not check account reference resolution, unsubmitted visibility or whether calculated obligations exist. An empty or malformed catalogue fails before load starts. The catalogue stays fixed during measurement so the workload is reproducible.

The rate is `ceil(organisation count × 60 / PRN_TEST_REFRESH_WINDOW_SECONDS)` requests per minute. The default refresh window is 1,800 seconds, independently of the default **30-minute measured duration**. With 500 organisations, a 30-minute window gives 17 requests/minute; 15 minutes gives 34; 10 minutes gives 50. Organisation IDs rotate evenly and repeat after a complete pass. The test holds that arrival rate even when Azure slows down. It deliberately does not copy the backend's rate cap, latency adjustment or retries, so insufficient throughput remains visible.

Run from the repository root with Node 22+ and k6 installed (`brew install k6` on macOS). Proxy support for the Node catalogue request requires Node 24.5+ or a release with `--use-env-proxy` backported. These commands copy a template over `env.sh`; preserve any existing local configuration first.

Local services:

```sh
cp scenarios/backend/env.prn-local.sh.template env.sh
./entrypoint.sh
```

The local template targets the real `epr-local-environment` waste-organisations service on port 8006 (Basic auth) and PRN backend on port 5168 (no Azure auth gateway). Start `waste-organisations-seed` and `epr-prn-common-backend` with their dependencies in that stack first. A functional smoke can use `PRN_TEST_REFRESH_WINDOW_SECONDS=60` and `PRN_TEST_DURATION=1m`. For the Azure stub instead, point the URLs at `http://localhost:8011/waste-organisations` and `http://localhost:8011/epr-prn-common-backend`; use PRN OAuth with token URL `http://localhost:8011/oauth2/v2.0/token`, a non-empty scope and dummy client credentials. Stub verification establishes harness behaviour, not Azure performance.

Azure TEST PRN and CDP test organisations, called from your machine:

```sh
cp scenarios/backend/env.prn-test.sh.template env.sh
# Fill in both services' client credentials and the Waste Organisations token URL/scope.
./entrypoint.sh
```

The TEST template contains the PRN base URL, Microsoft token endpoint and resource scope from the waste-obligations TEST integration. Supply authorised credentials for each service. Waste Organisations OAuth clients need read access. A successful local run does not establish that deployed credentials, network access or Azure permissions are configured. This profile requires no Azure-stub session, waste-obligations Basic credentials or browser sign-in. It is excluded from `TEST_SCENARIO=all`; it can also run through the backend entrypoint with `TEST_SCENARIO=prn-obligations/sustained.js`.

| Setting | Purpose/default |
| --- | --- |
| `WASTE_ORGANISATIONS_BASE_URL` | Required catalogue service base URL |
| `WASTE_ORGANISATIONS_AUTH_MODE` | `oauth2` (default) or `basic` for local services |
| `WASTE_ORGANISATIONS_CLIENT_ID`, `WASTE_ORGANISATIONS_CLIENT_SECRET` | Required catalogue credentials |
| `WASTE_ORGANISATIONS_TOKEN_URL`, `WASTE_ORGANISATIONS_SCOPE` | OAuth token endpoint and optional requested scope |
| `WASTE_ORGANISATIONS_TOKEN_AUTH_METHOD` | `basic` (default) or `body` client authentication |
| `PRN_API_BASE_URL` | Required PRN service base URL; never inferred from `ENVIRONMENT` |
| `PRN_API_AUTH_MODE` | `oauth2` (default) or explicit `none` for the local backend |
| `PRN_API_TOKEN_URL`, `PRN_API_CLIENT_ID`, `PRN_API_CLIENT_SECRET`, `PRN_API_SCOPE` | Required for PRN OAuth |
| `PRN_API_TOKEN_AUTH_METHOD` | `body` (default, matching Azure integration) or `basic` |
| `PRN_TEST_OBLIGATION_YEAR` | Defaults to the current UTC year; templates explicitly select 2026 |
| `PRN_TEST_REFRESH_WINDOW_SECONDS` | Positive integer, default 1800; reducing it increases traffic |
| `PRN_TEST_DURATION` | Measured duration, default `30m`; accepts integer `s`, `m`, `h` |
| `PRN_TEST_PREALLOCATED_VUS`, `PRN_TEST_MAX_VUS` | Default 5/50; increase if the generator drops iterations |
| `PRN_TEST_REQUEST_TIMEOUT_SECONDS` | Default 60; applies to token, catalogue and PRN requests |
| `PRN_TEST_P95_MS` | Optional latency pass threshold; no latency SLA assumed by default |

PRN tokens are acquired before measurement and cached per VU after the initial shared token. Each VU renews before expiry, including with the stub's 60-second tokens. Token renewals can occupy a VU; PRN-only latency is recorded separately. The catalogue OAuth exchange is outside the k6 measured workload. Scope is sent in the form-encoded token body. Token requests are tagged `endpoint=prn_oauth`; PRN requests use `endpoint=prn_obligations`. Secrets and tokens are not written to the prepared catalogue or reports. Do not enable HTTP debug logging when using real credentials.

Reports are under `results/backend/prn-obligations/sustained/` when using the root entrypoint, or `scenarios/backend/results/prn-obligations/sustained/` for the backend entrypoint:

- `summary.html`, `summary.json`, `junit.xml`: standard k6 reports. `prn_obligation_duration` measures PRN latency, `prn_obligation_failed` covers HTTP and response-contract failures, and `dropped_iterations` shows unmet load. Overall HTTP metrics also include PRN OAuth requests.
- `catalogue.json`: selected IDs, rate, URLs and test configuration, without credentials.
- `coverage.json`: unique organisations attempted/successful, requests per organisation, HTTP status counts, and PRN-only per-minute p50/p95/p99 latency. First and last wall-clock minute buckets can be partial.
- `samples.json`: raw k6 metric samples, retained for further analysis.

HTTP/contract failures, authentication failures or dropped iterations fail the run. Responses must be HTTP 200 with valid `obligationData` and `numberOfPrnsAwaitingAcceptance`; zero/no obligations is valid. Unsupported-year 400s and 404s are failures, even though the backend can treat these as no-data cases. Full successful catalogue coverage is required when the duration spans a complete refresh window; deliberate shorter local smoke runs report partial coverage. Setup and graceful completion can extend wall-clock runtime beyond the measured duration.

## Existing backend scenarios

K6 API tests. Each endpoint has a `baseline` smoke (1 VU, 1 iteration) and a
`load` test using the **open model** (`constant-arrival-rate`) at a fixed RPS
target. Get/search endpoints are driven at **20 req/s**, create/update at
**10 iter/s** (POST + PATCH + GET lifecycle per iteration).

When `TEST_SCENARIO=all`, the runner is **gated**: every baseline runs first,
and the **first failing baseline aborts the run** before any load test starts.
Single-scenario invocations (`TEST_SCENARIO=path/to/file.js`) bypass the gate.

## Layout

```
scenarios/backend/
├── lib/
│   ├── config.js       baseUrl, headers, org-id picker, think-time
│   ├── payloads.js     POST create + PATCH update bodies
│   └── summary.js      handleSummary → HTML + JSON + JUnit
└── tests/
    ├── get-obligations/{baseline,load}.js
    ├── get-compliance-declarations/{baseline,load}.js
    ├── create-compliance-declaration/{baseline,load}.js
    ├── search-compliance-declarations/{baseline,load}.js
    └── get-unsubmitted-organisations/{baseline,scenario-a-load,scenario-b-stress,spike,capacity}.js
```

## Local run (host k6)

1. Install k6 — `brew install k6` (macOS) or follow https://k6.io/docs/get-started/installation/.
2. Copy `env.sh.template` → `env.sh` and fill in
   `WASTE_OBLIGATION_USERNAME` / `WASTE_OBLIGATION_PASSWORD`.
3. Run the suite:
   ```sh
   ./entrypoint.sh
   ```
   Or a single scenario:
   ```sh
   TEST_SCENARIO=get-compliance-declarations/baseline.js ./entrypoint.sh
   ```

Reports land in `results/<scenario>/summary.html` (k6-reporter), `summary.json`,
`junit.xml`. The entrypoint writes an aggregating `results/index.html` —
counter cards (scenarios passed, total requests, mean p(95), overall fail rate),
the per-scenario summary table, and Chart.js bar charts comparing latency,
throughput, failure rate, and check pass rate across scenarios. Chart.js, CSS,
and JS are vendored under `lib/report/` and copied alongside the HTML, so the
report works offline (file://) and survives S3 upload. Opens in the browser
when `CI=false`.

## Local run (Docker)

```sh
docker build -t waste-obligations-k6 .
docker run --rm \
  -e ENVIRONMENT=dev \
  -e CI=false \
  -e WASTE_OBLIGATION_USERNAME=... \
  -e WASTE_OBLIGATION_PASSWORD=... \
  -v "$(pwd)/results:/opt/perftest-k6/results" \
  waste-obligations-k6
```

## Scenarios

| Scenario | Profile | Endpoint |
| --- | --- | --- |
| `get-obligations/baseline.js` | 1 VU, 1 iter | `GET /organisations/{orgId}/obligations?obligationYear=2026` |
| `get-obligations/load.js` | 20 req/s, 1 min | same path; p(95)<2000ms |
| `get-compliance-declarations/baseline.js` | 1 VU, 1 iter | `GET /organisations/{orgId}/compliance-declarations?obligationYear=2026` |
| `get-compliance-declarations/load.js` | 20 req/s, 1 min | same path with full filter set; p(95)<2000ms |
| `create-compliance-declaration/baseline.js` | 1 VU, 1 iter | POST → PATCH → GET full lifecycle |
| `create-compliance-declaration/load.js` | 10 iter/s, 1 min | same lifecycle (30 req/s total); p(95)<2000ms on every request |
| `search-compliance-declarations/baseline.js` | 1 VU, 1 iter | `GET /compliance-declarations?obligationYear=2026` |
| `search-compliance-declarations/load.js` | 20 req/s, 1 min | same path with full filter set; p(95)<2000ms |
| `get-unsubmitted-organisations/baseline.js` | 1 VU, 1 iter | `GET /compliance-declarations/unsubmitted?obligationYear=2026` |
| `get-unsubmitted-organisations/scenario-a-load.js` | 10 req/min, 3 min | same path with full filter set (country, registrationType, pageSize=100); p(95)<2000ms |
| `get-unsubmitted-organisations/scenario-b-stress.js` | 40 req/min, 5 min | same path + filter set; p(95)<2000ms |
| `get-unsubmitted-organisations/spike.js` | ramp to 240 req/min over 5s, hold 10s | minimal query; spikeThresholds (p(95)<4000, fail<5%) |
| `get-unsubmitted-organisations/capacity.js` | 40 → 80 → 120 req/min ramp (6 min) | minimal query; capacity observation only (checks>0.5) |

## Authentication

`entrypoint.sh` base64-encodes `$WASTE_OBLIGATION_USERNAME:$WASTE_OBLIGATION_PASSWORD`
into `AUTH_TOKEN`, exported to k6. Scenarios send
`Authorization: Basic ${__ENV.AUTH_TOKEN}` via `lib/config.js`.

## CI

`.github/workflows/k6-perf-tests.yml` installs k6, runs the suite against the
selected `environment` input, and uploads `scenarios/backend/results/` and
`junit.xml` as workflow artifacts. JUnit results are surfaced via
`mikepenz/action-junit-report`.

Triggers:

- `workflow_dispatch` — pick `environment` (default `dev`) and `test_scenario`
  (default `all`).
- `push` to `main` touching `scenarios/backend/**` — runs the full suite
  against `dev`.

Secrets required: `WASTE_OBLIGATION_USERNAME`, `WASTE_OBLIGATION_PASSWORD`.
