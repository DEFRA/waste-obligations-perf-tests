# waste-obligations-perf-tests — Backend (K6)

K6 API load tests. Three endpoints (`GET`, `POST`+`PATCH`, search) each in
`baseline` (1 VU, smoke) and `load` (20 VUs, ramp + steady, p(95)<2s) variants.

## Layout

```
scenarios/backend/
├── lib/
│   ├── config.js       baseUrl, headers, org-id picker, think-time
│   ├── payloads.js     POST create + PATCH update bodies
│   └── summary.js      handleSummary → HTML + JSON + JUnit
└── tests/
    ├── get-compliance-declarations/{baseline,load}.js
    ├── create-compliance-declaration/{baseline,load}.js
    └── search-compliance-declarations/{baseline,load}.js
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
`junit.xml`. The entrypoint writes an aggregating `results/index.html` and opens
it in the browser when `CI=false`.

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
| `get-compliance-declarations/baseline.js` | 1 VU, 1 iter | `GET /organisations/{orgId}/compliance-declarations?obligationYear=2026` |
| `get-compliance-declarations/load.js` | 20 VUs, 30s ramp + 60s | same path with full filter set; p(95)<2000ms |
| `create-compliance-declaration/baseline.js` | 1 VU, 1 iter | POST → PATCH → GET full lifecycle |
| `create-compliance-declaration/load.js` | 20 VUs, 30s ramp + 60s | same lifecycle, with p(95)<2000ms on every request |
| `search-compliance-declarations/baseline.js` | 1 VU, 1 iter | `GET /compliance-declarations?obligationYear=2026` |
| `search-compliance-declarations/load.js` | 20 VUs, 30s ramp + 60s | same path with full filter set; p(95)<2000ms |

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
