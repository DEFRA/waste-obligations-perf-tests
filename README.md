# waste-obligations-perf-tests

Performance test runner for the CDP Platform. One image, one entrypoint, with
three independently selectable workloads:

- **Backend** — K6 API load tests under [`scenarios/backend/`](./scenarios/backend/).
- **Lighthouse** — Direct Producer and Compliance Scheme Officer browser
  performance audits.
- **Browser load** — Direct Producer and Compliance Scheme Officer journeys,
  backed by deterministic Azure-stub organisation allocations.

The root `entrypoint.sh` runs the selected workload and emits a unified
`results/index.html` linking to each phase's aggregated report:

```
results/
├── index.html          ← unified landing page
├── backend/
│   ├── index.html      ← K6 summary table
│   └── <scenario>/     ← per-scenario summary.html + JUnit XML
├── backend-logs/       ← per-scenario k6 stdout/stderr
└── frontend/
    ├── index.html      ← Lighthouse and/or browser-load summary
    └── <step>/         ← per-step report.html + report.json, when selected
```

- [Licence](#licence)
  - [About the licence](#about-the-licence)

## Build

The Docker image is built automatically by
[.github/workflows/publish.yml](.github/workflows/publish.yml) on every push to
`main`. The resulting image is run on the CDP Platform; credentials and
runtime env vars are injected by the portal.

## Run

The performance tests are designed to be run from the CDP Portal. The CDP
Platform runs them like any other service — it takes the Docker image and
runs it as an ECS task. Set the Portal **Profile** field to select the
workload; the value is injected as `PROFILE`.

| `PROFILE` | Runs |
| --- | --- |
| `all` (default) | K6, Lighthouse, then browser load |
| `k6` | K6 only |
| `lighthouse` | Direct Producer and Compliance Scheme Officer Lighthouse audits |
| `browser-load` | Stub-initialised browser load test only |

Unknown profile values fail before any test work starts. `ENVIRONMENT` remains
independent: it chooses the default target hosts, while `PROFILE` chooses the
workload. `TEST_SCENARIO` still selects a specific K6 script when the selected
profile includes K6.

Every profile requires `EPR_AZURE_STUB_BASE_URL`. Before any workload starts,
the runner acquires an exclusive run lease from the stub and renews it at most
once per minute. A second run against the same stub receives `409 Conflict`;
the lease is released on normal or failed completion and otherwise expires
after `EPR_LOAD_TEST_LEASE_DURATION_SECONDS` (600 seconds by default). This
keeps K6, Lighthouse and browser-load from overlapping against the same target
data. Restrict the stub's `/admin/load-test-runs` and `/admin/load-test-sessions`
routes to the performance-test runner at ingress.

## Local Running

### Using the Entrypoint Script

Copy `env.sh.template` to `env.sh`, set `EPR_AZURE_STUB_BASE_URL`, and fill in
the shared K6 basic-auth vars and credentials for the account types included in
the browser load-test mix.
In the `all` profile, Lighthouse audits each account type represented in that
mix. The explicit `lighthouse` profile audits both account types.

```bash
./entrypoint.sh
```

The default profile runs K6 first, then Lighthouse and browser load, then
writes the unified index and opens it in your browser when `CI=false`. Set
`PROFILE=browser-load` for only the browser load test, `PROFILE=lighthouse`
for Lighthouse only, or `PROFILE=k6` for K6 only.

You'll need [k6](https://k6.io/docs/get-started/installation/) and Node 22+
installed locally (`brew install k6 node` on macOS). The Lighthouse phase
installs its npm deps on first run. Alternatively, use Docker.

### Using Docker

```bash
# Configure compose/perf-tests.env from the template
cp compose/perf-tests.env.template compose/perf-tests.env

# Build and run
docker compose up --build
```

Results land in `./reports/` (volume-mounted from
`results/` in the container) and are viewable at http://localhost:8080.

## Scenarios

See [`scenarios/backend/README.md`](./scenarios/backend/README.md) for the
full K6 list and load models. With `TEST_SCENARIO=all`, every baseline is run
first as a gate, followed by the capacity, load, stress and spike scenarios;
the local-only soak test is excluded.

Authentication is HTTP Basic. `scenarios/backend/entrypoint.sh` base64-encodes
`$WASTE_OBLIGATION_USERNAME:$WASTE_OBLIGATION_PASSWORD` once at startup and
exports it as `AUTH_TOKEN`, which the scenarios send as
`Authorization: Basic ${__ENV.AUTH_TOKEN}`.

## Reporting

The root entrypoint writes a unified `results/index.html` with two cards
(Backend, Frontend) showing pass/fail status and step/scenario counts. Each
card links to that phase's own aggregated index. Per-phase outputs:

- **Backend (K6)**: per-scenario `summary.html`, `summary.json`, `junit.xml`
  under `results/backend/<scenario>/`; aggregated `results/backend/index.html`.
- **Frontend**: Lighthouse reports and/or browser-load timing results under
  `results/frontend/`; aggregated at `results/frontend/index.html`.

In CI mode (`CI=true` and `RESULTS_OUTPUT_S3_PATH` set), the root entrypoint
makes a single S3 upload of the whole `results/` tree.

## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

<http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3>

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government licence v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable
information providers in the public sector to license the use and re-use of their information under a common open
licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
