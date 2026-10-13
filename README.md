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
| `unsubmitted` | Shared 500 organisation polling data and K6 reads, without browser login |
| `unsubmitted-journey` | The same polling reads concurrently with journeys for a random subset of that pool |

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

### Unsubmitted polling profiles

Set `PROFILE=unsubmitted` in `env.sh` for polling alone, or
`PROFILE=unsubmitted-journey` for concurrent K6 reads and browser journeys.
Both use the root entrypoint and its exclusive lease/heartbeat. For example:

```sh
export PROFILE=unsubmitted-journey
export LOAD_TEST_USER_COUNT=500
export LOAD_TEST_CSO_PERCENTAGE=75
export LOAD_TEST_OBLIGATION_YEAR=2026
export LOAD_TEST_BROWSER_SAMPLE_COUNT=10
export LOAD_TEST_POLL_DURATION=30m
./entrypoint.sh
```

The 500 initial IDs are 125 Direct Producers and 375 Compliance Schemes with the
default mix. They belong to the two seeded authenticated users. The root creates
this pool once; the frontend reuses those allocations and authenticates once per
included type. It samples 10 accounts by default and runs one journey each,
preserving each original session index. `LOAD_TEST_SAMPLE_SEED` makes selection
repeatable. Selected IDs and type/name correlation are saved with the browser
results. Even samples cancel and odd samples delete their submitted declaration.
Each must disappear from the public unsubmitted view after submission and
reappear after restoration; failed state assertions fail the run. API credentials
and the performance-test API key must permit deletion. Existing profiles retain
their cancellation cleanup and iteration/arrival-rate behaviour.

Before workloads start, the public paged view must contain every initial ID with
a reference and calculated metrics for the target year. The default readiness
timeout is 15 minutes (`LOAD_TEST_READINESS_TIMEOUT_MS=900000`). Historical-year
readiness requires a backfill already present in Waste Obligations; the runner
does not change service configuration. The target year defaults to the current
UK year, except January uses the previous year.

`LOAD_TEST_REGISTRATION_YEARS` defaults to 2025–2030 as a comma-separated list;
each year must be 2023–2050 and include the target year.
`LOAD_TEST_CHANGE_INTERVAL_SECONDS` defaults to 300 (1–86400).
`LOAD_TEST_MAX_ADDITIONAL_ORGANISATIONS` defaults to 288; initial count plus
growth is capped at 1000. One organisation is added per interval from run
initialisation. Independently, each organisation/year changes PRN values once
per interval from its first PRN read. Initial IDs stay stable. The hydration
hash-slot schedule can read just before a PRN change, so a changed value may
appear after the following complete refresh (typically 5–10 minutes).
K6 reads run for 30 minutes by default, at 60 requests/minute
(`LOAD_TEST_POLL_DURATION`, `LOAD_TEST_POLL_RATE_PER_MINUTE`, bounded 1–6000).
Reads mix paging, registration/country filters, name search and sorting.

The manifest is `results/polling-catalogue.json`; K6 HTML/JSON/JUnit reports are
under `results/backend/unsubmitted-polling/`. The lease clears the stub catalogue
on release or expiry. Stored Waste Obligations snapshots survive a run, which is
why readiness checks exact fresh-run IDs. Restrict `/admin/load-test-polling`
alongside the other controls at ingress and run one stub replica. No live
configuration change or deployment is performed by the runner.

Run helper tests with `node --test lib/unsubmitted-polling.test.mjs`, and the
frontend checks with `npm test` in `scenarios/frontend`.

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
