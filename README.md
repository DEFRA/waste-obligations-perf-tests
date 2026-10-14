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

`PROFILE=unsubmitted` reads the public unsubmitted view without browser login.
`PROFILE=unsubmitted-journey` runs those reads alongside unique browser journeys.
Both use the root entrypoint and its exclusive stub lease/heartbeat.

The runner first reads the deployed service's admin-authorised
`GET /admin/unsubmitted-compliance-declarations/polling-configuration`. It rejects
missing endpoints, disabled pollers, malformed timings and explicit expectations
that disagree with the service. Runner variables do not configure the service.

| Lever | Owner / variable | Default and effect |
| --- | --- | --- |
| Organisation discovery | Service `OrganisationEligibility__RefreshPollIntervalSeconds` | 1800 seconds in perf-test |
| Obligation refresh target | Service `OrganisationObligationHydration__RefreshInterval` | `00:30:00` |
| Summary staleness threshold | Service `OrganisationObligationHydration__MaximumSummaryStaleness` | `01:00:00`; observational logs/metrics, not a promise that every visible row is younger |
| Downstream request cap | Service `OrganisationObligationHydration__MaxDownstreamRequestsPerMinute` | 180 in perf-test; the service default is 20 |
| Hydration worker wake-up | Service `OrganisationObligationHydration__PollIntervalSeconds` | 60 seconds; batch/concurrency and pacing can add latency |
| Service expectations | Runner `LOAD_TEST_STALENESS_SECONDS`, `LOAD_TEST_EXPECTED_ORGANISATION_POLL_INTERVAL_SECONDS`, `LOAD_TEST_EXPECTED_OBLIGATION_REFRESH_INTERVAL_SECONDS` | Unset: use actual runtime values. Set: fail on mismatch |
| Measured windows | Runner `LOAD_TEST_POLL_CYCLES` | 2 times the largest discovery, refresh or pool/capacity window, and at least one staleness window; normally 60 minutes |
| Explicit measured duration | Runner `LOAD_TEST_POLL_DURATION` | Optional `ms`, `s`, `m` or `h` value, at most 24 hours; shorter than the required windows needs `LOAD_TEST_ALLOW_SHORT_SMOKE=true` |
| Readiness budget | Runner `LOAD_TEST_READINESS_TIMEOUT_MS` | Derived discovery + two schedule windows + capacity/wake-up headroom; about 94 minutes for 500 at defaults, at most 24 hours |
| Task budget | Runner `LOAD_TEST_TASK_BUDGET_SECONDS` | 7200 seconds, bounded by the CDP two-hour limit; lower values are allowed. Five minutes are reserved for cleanup and reports |
| Authentication timeout | Runner `LOAD_TEST_AUTH_TIMEOUT_SECONDS` | 900 seconds for combined runs; reserved before readiness and enforced by the authentication barrier |
| Initial organisation pool | Runner `LOAD_TEST_USER_COUNT`, `LOAD_TEST_CSO_PERCENTAGE` | 500 total, 75% schemes: 125 producers and 375 schemes; 750 is also supported |
| Allocation bound | Stub `LoadTest__MaxOrganisationCount` | 100000, configurable 1–1000000; initial pool plus maximum growth must fit |
| Source organisation growth | Runner initialisation `LOAD_TEST_ORGANISATION_GROWTH_INTERVAL_SECONDS` | 1800 seconds; one extra ID per elapsed interval from initialisation |
| Source PRN change period | Runner initialisation `LOAD_TEST_OBLIGATION_CHANGE_INTERVAL_SECONDS` | 1800 seconds independently per organisation/year from first PRN read |
| Growth cap / years | Runner `LOAD_TEST_MAX_ADDITIONAL_ORGANISATIONS`, `LOAD_TEST_REGISTRATION_YEARS` | 288 additional IDs; years 2025–2030, each within 2023–2050 |
| Target year | Runner `LOAD_TEST_OBLIGATION_YEAR` | Actual service current year; historical years need an existing backfill |
| Public read rate | Runner `LOAD_TEST_POLL_RATE_PER_MINUTE` | 60 iterations/minute, configurable 1–6000; name searches can issue additional paged requests |
| Unique journey arrivals | Runner `LOAD_TEST_JOURNEY_RATE_PER_MINUTE` | 1/minute, independently configurable above 0 and at most 600 |
| Accepted outcome mix | Runner `LOAD_TEST_ACCEPT_PERCENTAGE` | 50%; the remainder cancel |
| Journey concurrency | Runner `LOAD_TEST_JOURNEY_CONCURRENCY` | 4; saturation records missed slots and fails the run |
| Optional journey cap | Runner `LOAD_TEST_JOURNEY_LIMIT` | No sample cap by default; legacy `LOAD_TEST_BROWSER_SAMPLE_COUNT` is an explicit cap alias |
| Queue order | Runner `LOAD_TEST_SAMPLE_SEED` | Random initial-pool order, optional repeatable seed |

Set the profile and values in the root `env.sh`. Default production cadence:

```sh
export PROFILE=unsubmitted-journey
export LOAD_TEST_USER_COUNT=500
export LOAD_TEST_JOURNEY_RATE_PER_MINUTE=1
export LOAD_TEST_ACCEPT_PERCENTAGE=50
export LOAD_TEST_POLL_CYCLES=2
./entrypoint.sh
```

Use `LOAD_TEST_USER_COUNT=750` for the larger pool with the same timings.
To increase service-side polling traffic, deploy organisation discovery at 300
seconds and obligation refresh at `00:05:00`, keeping staleness at `01:00:00`.
Set the matching optional expectation variables to 300, 300 and 3600. The runner
still measures 60 minutes because it still needs to cover the staleness threshold.
For an explicitly shorter local smoke run, set `LOAD_TEST_POLL_DURATION=1m` and
`LOAD_TEST_ALLOW_SHORT_SMOKE=true`; this does not prove two production windows.
The old `LOAD_TEST_CHANGE_INTERVAL_SECONDS` is deprecated and supplies both
source periods only when their new independent variables are absent.

Readiness checks every original ID, reference and calculated target-year metric
through public pages of at most 100. CDP stops performance tasks after two hours.
Readiness is capped by the remaining
task budget after reserving the full measured window, five minutes for cleanup and
reports, and the authentication timeout (15 minutes by default) for combined runs.
At defaults this leaves at most 55 minutes for polling-only readiness or 40 minutes
for combined readiness, less time already spent acquiring the lease and setting up.
The runner checks the budget again after authentication and fails if the complete
measured window cannot fit; it never shortens that window automatically. A watchdog
stops setup or workloads when only the five-minute cleanup reserve remains, including
journeys still draining after the measured window. Deadline termination fails the run.

The readiness sweep runs every five seconds and reads all pages, adding public API
traffic before measurement. This traffic is excluded from the K6 results. The
readiness budget is a timeout, not a forced wait. Warm-up ends as soon as those rows
are ready. Total runtime is warm-up, authentication,
the measured window and any in-flight journey drain. Flags and observation windows
alone do not establish metric age: worker slots, downstream pacing and retries can
add latency. Extremely short discovery/refresh intervals can increase generation
contention rather than shorten warm-up. PRN values change from their own first-read anchor, including numeric
changes across skipped phases; the next worker slot may observe a change later.

After readiness, the frontend authenticates once for each included seeded user
and builds the initial queue. A startup barrier starts K6 and browser arrivals at
a shared timestamp. At defaults, 60 unique organisations start once each during
60 minutes, leaving 440 unused from a 500 pool. Cancellation restores visibility
but never requeues that ID. Successful Accepted outcomes remain Accepted and absent.
Failed journeys cancel remaining declarations. Each transition verifies
persisted declaration status and exact-ID membership through a scoped name/type
search. Browser failures fail the run and still attempt cleanup. Missed arrival slots are recorded without a catch-up burst. Pool exhaustion
stops new journeys, reports exhaustion and allows K6 reads to finish; it is not a
failure by itself. Growth IDs remain eligible for reads but never enter the immutable
initial journey queue. Legacy profiles keep their existing dispatch/cleanup.

The root runner owns separate frontend and K6 process groups, tracks detached
browser descendants and stops/reaps those workloads before releasing the lease
on timeout or interruption. Cleanup failure stops the heartbeat and leaves the
lease to expire, instead of releasing it while a workload may still be active.

`results/polling-catalogue.json` saves actual runtime configuration, derived budgets,
year, source periods and the original catalogue. K6 saves a configuration JSON with
its HTML/JSON/JUnit reports under `results/backend/unsubmitted-polling/`. Browser
results record every selected ID, outcome, missed slot and remaining queue; the root
HTML displays effective configuration. Public read checks retain calculated metrics
for original IDs, allow new growth to await hydration, and adjust count minima for
the maximum number of unique submitted/accepted journeys during the whole window.

Release/expiry clears process-local stub allocations; the two seeded browser
organisations remain as a baseline. Persisted service snapshots can survive a run,
so readiness uses exact fresh-run IDs. Restrict all three stub administrative routes
at ingress and run one stub replica.

Deploy in order: Waste Obligations timing endpoint, stub, perf-test service config,
then runner. The new runner requires the endpoint and fails clearly during a rolling
backward deployment; it never grants itself admin access or changes live settings.
Run root helper tests with `node --test lib/*.test.mjs` and frontend HTTP checks with
`npm test` in `scenarios/frontend`.

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
