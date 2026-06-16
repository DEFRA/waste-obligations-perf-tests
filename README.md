# waste-obligations-perf-tests

Performance test runner for the CDP Platform. One image, one entrypoint, two
phases:

- **Backend** — K6 API load tests under [`scenarios/backend/`](./scenarios/backend/).
- **Frontend** — Lighthouse CSOC perf audits under
  [`scenarios/frontend/`](./scenarios/frontend/).

The root `entrypoint.sh` runs both phases and emits a unified
`results/index.html` linking to each phase's aggregated report:

```
results/
├── index.html          ← unified landing page
├── backend/
│   ├── index.html      ← K6 summary table
│   └── <scenario>/     ← per-scenario summary.html + JUnit XML
├── backend-logs/       ← per-scenario k6 stdout/stderr
└── frontend/
    ├── index.html      ← Lighthouse summary table
    └── <step>/         ← per-step report.html + report.json
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
runs it as an ECS task. Both phases execute on a single run; phase failures
are OR-combined into the run's exit code.

## Local Running

### Using the Entrypoint Script

Copy `env.sh.template` to `env.sh` and fill in credentials for both phases —
shared K6 basic-auth vars, DefraID UI vars for Lighthouse, and an
`EPR_ORG_ID` for the CSOC reset/submit.

```bash
./entrypoint.sh
```

The script runs K6 first, then Lighthouse, then writes the unified index and
opens it in your browser when `CI=false`. To skip Lighthouse (e.g. when only
the API tests are needed), set `LIGHTHOUSE_SKIP=true` in `env.sh`.

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
full K6 list and load profiles. Six K6 scripts cover three endpoints, each
in `baseline` (1 VU, 1 iteration smoke test) and `load` (20 VUs, 30s ramp +
30s steady, p(95)<2s) variants.

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
- **Frontend (Lighthouse)**: per-step `report.html` and `report.json` under
  `results/frontend/<step>/`; aggregated `results/frontend/index.html`.

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
