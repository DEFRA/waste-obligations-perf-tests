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
| `unsubmitted-journey` | The same polling reads concurrently with reusable submit/cancel journeys for expected organisations |

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
`PROFILE=unsubmitted-journey` runs those reads alongside reusable submit/cancel browser cycles.
Both use the root entrypoint and its exclusive stub lease/heartbeat.

`unsubmitted-journey` also runs a dedicated endpoint performance workload. After
the stub has seeded the initial catalogue, it runs a baseline (1 VU, 1 iteration,
all checks must pass), then repeats Scenario A (10 requests/minute for 3 minutes)
and Scenario B (40 requests/minute for 5 minutes). This starts before service
readiness and browser authentication, so the first rounds observe initial
hydration and later rounds overlap submit/cancel journeys. It finishes the
current A/B round after the existing workloads end. A new round is not started
unless both phases, graceful stops, runner overhead and the five-minute cleanup
reserve fit inside the task budget. Spike and capacity remain separately
selectable backend scripts; they are not added to these SLA rounds.
If the budget prevents another round while the existing workloads are still
active, the session fails with incomplete API coverage rather than reporting
the earlier rounds as a passing full session.

Each A/B iteration issues **one** `GET /compliance-declarations/unsubmitted`,
rotating through pages of 100 for the initial pool and extending to later pages
as the observed total grows. Pages can be empty during hydration or submissions.
Checks validate HTTP 200, the paged response and target-year row structure,
allowing pending obligation metrics. Latency is gated by p95, not a per-response
two-second check. Each phase independently requires p95 below 2000 ms, failures
below 1%, checks above 99%, no dropped arrivals and at least the scheduled request
count (30 for A, 200 for B). A failed baseline prevents API load; a failed A/B
phase is retained and fails the session while later rounds continue collecting
evidence. Existing polling and browser outcome gates remain in force.

The 10/40 requests/minute are **dedicated API traffic**. Existing K6 polling,
readiness scans, browser discovery and journey membership verification generate
additional unsubmitted requests. The rates are not a cap on total endpoint
traffic, and other service activity can add further load.

Before API measurement starts, logs print an allowlisted effective configuration,
also saved as `results/run-configuration.json`. It records deployed discovery,
hydration, staleness and downstream pacing settings from the admin configuration
endpoint; seeded DP/CSO counts and source change periods; actual test windows,
arrival rates, concurrency and limits; task/authentication/readiness budgets;
and target hostnames. It records only credential-presence flags and omits tokens,
API keys, passwords, email addresses, URL userinfo, paths and query strings.
It does not dump CDP secrets or the process environment. Settings the service's
configuration endpoint does not expose are not inferred from runner variables.

Open `results/index.html` for the session, including the endpoint performance
card. Per-phase reports are saved under:

```text
results/get-unsubmitted-organisations/
├── index.html
├── session.json
├── baseline/summary.{html,json}
├── round-001/scenario-a-load/summary.{html,json}
├── round-001/scenario-b-stress/summary.{html,json}
└── round-002/...
```

Each phase also saves JUnit XML and a k6 log. The endpoint index shows phase
timestamps, the shared browser/polling start when available, later-page request
counts, observed total min/max and SLA metrics. Totals describe responses observed
during the phase; they do not prove all seeded obligations have hydrated.

For a local wiring check only, `LOAD_TEST_ALLOW_SHORT_SMOKE=true` permits
`LOAD_TEST_API_SCENARIO_A_DURATION=30s` and
`LOAD_TEST_API_SCENARIO_B_DURATION=30s`, alongside a shortened
`LOAD_TEST_POLL_DURATION`. These retain the 10/40 arrival rates but label results
SMOKE; remove the API duration overrides and smoke flag for the CDP release run.
The baseline and SLA scripts also respect `LOAD_TEST_OBLIGATION_YEAR`; within
the journey session they use the current year selected during initialisation.

The runner first reads the deployed service's admin-authorised
`GET /admin/unsubmitted-compliance-declarations/polling-configuration`. It rejects
missing endpoints, disabled pollers, malformed timings and explicit expectations
that disagree with the service. Runner variables do not configure the service.

| Lever | Owner / variable | Default and effect |
| --- | --- | --- |
| Organisation discovery | Service `OrganisationEligibility__RefreshPollIntervalSeconds` | 300 seconds in perf-test; production defaults to 1800 seconds with the poller disabled |
| Obligation refresh target | Service `OrganisationObligationHydration__RefreshInterval` | `00:30:00` |
| Summary staleness threshold | Service `OrganisationObligationHydration__MaximumSummaryStaleness` | `01:00:00`; observational logs/metrics, not a promise that every visible row is younger |
| Downstream request cap | Service `OrganisationObligationHydration__MaxDownstreamRequestsPerMinute` | 180 in perf-test; the service default is 20 |
| Hydration worker wake-up | Service `OrganisationObligationHydration__PollIntervalSeconds` | 60 seconds; batch/concurrency and pacing can add latency |
| Service expectations | Runner `LOAD_TEST_STALENESS_SECONDS`, `LOAD_TEST_EXPECTED_ORGANISATION_POLL_INTERVAL_SECONDS`, `LOAD_TEST_EXPECTED_OBLIGATION_REFRESH_INTERVAL_SECONDS` | Unset: use actual runtime values. Set: fail on mismatch |
| Measured windows | Runner `LOAD_TEST_POLL_CYCLES` | 2 times the largest discovery, refresh or pool/capacity window, and at least one staleness window; normally 60 minutes |
| Explicit measured duration | Runner `LOAD_TEST_POLL_DURATION` | Optional `ms`, `s`, `m` or `h` value, at most 24 hours; shorter than the required windows needs `LOAD_TEST_ALLOW_SHORT_SMOKE=true` |
| Readiness budget | Runner `LOAD_TEST_READINESS_TIMEOUT_MS` | Derived discovery + two schedule windows + capacity/wake-up headroom; about 69 minutes for 500 at perf-test defaults; positive explicit timeouts may be shorter, at most 24 hours |
| Task budget | Runner `LOAD_TEST_TASK_BUDGET_SECONDS` | 7200 seconds, bounded by the CDP two-hour limit; lower values are allowed. Clock starts at runner entrypoint; five-minute cleanup/report reserve is best effort |
| Authentication timeout | Runner `LOAD_TEST_AUTH_TIMEOUT_SECONDS` | 900 seconds for combined runs; reserved before readiness and enforced by the authentication barrier |
| Initial organisation pool | Runner `LOAD_TEST_USER_COUNT`, `LOAD_TEST_CSO_PERCENTAGE` | 500 total, 75% schemes: 125 producers and 375 schemes; 750 is also supported |
| Allocation bound | Stub `LoadTest__MaxOrganisationCount` | 100000, configurable 1–1000000; initial pool plus maximum growth must fit |
| Source organisation growth | Runner initialisation `LOAD_TEST_ORGANISATION_GROWTH_INTERVAL_SECONDS` | 1800 seconds; one extra ID per elapsed interval from initialisation |
| Source PRN change period | Runner initialisation `LOAD_TEST_OBLIGATION_CHANGE_INTERVAL_SECONDS` | 1800 seconds independently per organisation/year from first PRN read |
| Growth cap / years | Runner `LOAD_TEST_MAX_ADDITIONAL_ORGANISATIONS`, `LOAD_TEST_REGISTRATION_YEARS` | 288 additional IDs; years 2025–2030, each within 2023–2050 |
| Target year | Runner `LOAD_TEST_OBLIGATION_YEAR` | Actual service current year; historical years need an existing backfill |
| Public read rate | Runner `LOAD_TEST_POLL_RATE_PER_MINUTE` | 60 iterations/minute, configurable 1–6000; name searches can issue additional paged requests |
| Journey cycle arrivals | Runner `LOAD_TEST_JOURNEY_RATE_PER_MINUTE` | 1/minute, independently configurable above 0 and at most 600 |
| Journey concurrency | Runner `LOAD_TEST_JOURNEY_CONCURRENCY` | 4; saturation records missed slots and fails the run |
| Optional journey cap | Runner `LOAD_TEST_JOURNEY_LIMIT` | Unlimited cycles during the window by default; legacy `LOAD_TEST_BROWSER_SAMPLE_COUNT` is an explicit cap alias |

The downstream request cap is a ceiling. Warm-up pacing adapts to active and due
work relative to the refresh interval, with headroom; it can remain below 180 requests
per minute. Pool size divided by the cap is a lower bound, not a readiness promise.

Set the profile and values in the root `env.sh`. Default perf-test cadence:

```sh
export PROFILE=unsubmitted-journey
export LOAD_TEST_USER_COUNT=500
export LOAD_TEST_JOURNEY_RATE_PER_MINUTE=1
export LOAD_TEST_POLL_CYCLES=2
./entrypoint.sh
```

Use `LOAD_TEST_USER_COUNT=750` for the larger pool with the same timings.
Five-minute discovery is specific to perf-test; production retains its 30-minute
discovery interval and disabled poller. To increase obligation polling traffic further,
keep discovery at 300 seconds and deploy obligation refresh at `00:05:00`, keeping
staleness at `01:00:00`.
Set the matching optional expectation variables to 300, 300 and 3600. The runner
still measures 60 minutes because it still needs to cover the staleness threshold.
For an explicitly shorter local smoke run, set `LOAD_TEST_POLL_DURATION=1m` and
`LOAD_TEST_ALLOW_SHORT_SMOKE=true`; this does not prove two production windows.
The old `LOAD_TEST_CHANGE_INTERVAL_SECONDS` is deprecated and supplies both
source periods only when their new independent variables are absent.

Polling-only readiness checks every original ID, reference and calculated target-year
metric through public pages of at most 100. Combined readiness ends when at least
one exact ID from this run's original catalogue appears for the target year;
metrics and references do not gate browser startup. Stale IDs and later source-growth
IDs never receive browser journeys. The catalogue records the initial sightings. CDP stops performance tasks after two hours.
The runner measures its budget from entrypoint start, after container startup; it
has no CDP task-start timestamp. Its watchdog and five-minute cleanup reserve are
best effort: time before the entrypoint, scheduling delays and slow cleanup or
report uploads can consume the margin before the platform cutoff.
Readiness is capped by the remaining runner
time budget after reserving the full measured window, five minutes for cleanup and
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

After readiness, the frontend checks that its session allocations match the original
catalogue, then authenticates once for each included DP/CSO user type. A startup
barrier starts K6 and browser arrivals at a shared timestamp. During measurement,
a public discovery scan runs every five seconds after the previous scan completes.
Positive sightings of original target-year IDs accumulate even when offset pages
shift during submissions. Absence from one scan never removes an eligible ID.
Later source-growth IDs can appear in read checks but have no original sessions
and never enter the browser pool. Real browser journeys request any missing
obligations through the normal application flow.

Every cycle submits, verifies saved Submitted status and absence from unsubmitted,
cancels, then verifies saved Cancelled status and presence. Each ID has at most one
cycle in flight through finalization. Only a completely successful cycle returns
the account to the end of the ready queue for fair reuse. Any failure quarantines
that ID for the rest of the run, even when recovery cancellation succeeds.
Combined journeys always cancel; obsolete `LOAD_TEST_ACCEPT_PERCENTAGE` is ignored.
`LOAD_TEST_JOURNEY_LIMIT` optionally caps total started cycles, independently of
pool size; `LOAD_TEST_BROWSER_SAMPLE_COUNT` remains an explicit legacy cap alias.
The default has no cycle cap. Legacy profiles retain their dispatch and cleanup.

Arrivals use `LOAD_TEST_JOURNEY_RATE_PER_MINUTE`, independently of K6's polling
rate. The scheduler keeps launch spacing and never catches up with a burst. Empty
ready queues keep waiting for discovery; consuming the first ready batch does not
end the measurement. Reports separate timing misses, concurrency saturation and
data starvation. Any missed slot, failed cycle, discovery failure or a run with no
cycles fails the combined run. These outcomes distinguish partial readiness from
insufficient concurrency. The measured window stays fixed, then owned in-flight
journeys drain within the existing task watchdog and lease lifecycle.

The root runner owns separate frontend and K6 process groups, tracks detached
browser descendants and stops/reaps those workloads before releasing the lease
on timeout or interruption. Cleanup failure stops the heartbeat and leaves the
lease to expire, instead of releasing it while a workload may still be active.

`results/polling-catalogue.json` saves actual runtime configuration, derived budgets,
year, source periods and the original catalogue. K6 saves a configuration JSON with
its HTML/JSON/JUnit reports under `results/backend/unsubmitted-polling/`. Browser
results record total cycles separately from unique organisations, discovered and
never-seen original IDs, quarantined IDs, remaining available accounts, effective
configuration and each category of missed slots. Discovery traffic is additional
to K6 traffic. Combined K6 checks allow null pending metric fields and omit full
pool count minima while submissions change membership; structural, reference,
year, type and filter checks remain. Polling-only keeps calculated initial metrics
and its full-pool checks. Run reports measure reads and journeys while discovery,
obligation hydration and source changes overlap; they do not establish metric age
or synchronization correctness without the runtime state/membership checks.

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

You'll need [k6](https://k6.io/docs/get-started/installation/) and Node 24.22.1+
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
