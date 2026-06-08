# waste-obligations-perf-tests

A K6-based performance test runner for the CDP Platform. The K6 scenarios live
under [`scenarios-k6/`](./scenarios-k6/). The legacy JMeter `.jmx` files under
`scenarios/` are preserved for reference but are not executed.

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
runs it as an ECS task.

## Local Running

### Using the Entrypoint Script

The root `entrypoint.sh` delegates to `scenarios-k6/entrypoint.sh`, which runs
the K6 scenarios.

**Important**: the script sources `env.sh` automatically. Copy
`env.sh.template` to `env.sh` and fill in `WASTE_OBLIGATION_USERNAME` and
`WASTE_OBLIGATION_PASSWORD`.

```bash
# Run all scenarios (TEST_SCENARIO=all in env.sh)
./entrypoint.sh

# Or run a single scenario by setting TEST_SCENARIO in env.sh, e.g.
# TEST_SCENARIO=get-compliance-declarations/baseline.js
```

You will need [k6](https://k6.io/docs/get-started/installation/) installed
locally (`brew install k6` on macOS). Alternatively, use Docker.

### Using Docker

```bash
# Configure compose/perf-tests.env from the template
cp compose/perf-tests.env.template compose/perf-tests.env

# Build and run
docker compose up --build
```

Results land in `./reports/` (volume-mounted from
`scenarios-k6/results/` in the container) and are viewable at
http://localhost:8080.

## Scenarios

See [`scenarios-k6/README.md`](./scenarios-k6/README.md) for the full list and
load profiles. Six K6 scripts cover three endpoints, each in `baseline` (1 VU,
1 iteration smoke test) and `load` (20 VUs, 30s ramp + 30s steady, p(95)<2s)
variants.

Authentication is HTTP Basic. `scenarios-k6/entrypoint.sh` base64-encodes
`$WASTE_OBLIGATION_USERNAME:$WASTE_OBLIGATION_PASSWORD` once at startup and
exports it as `AUTH_TOKEN`, which the scenarios send as
`Authorization: Basic ${__ENV.AUTH_TOKEN}`.

## Reporting

Each scenario emits an HTML report (`summary.html`), a JSON summary
(`summary.json`) and a JUnit XML file (`junit.xml`) under
`scenarios-k6/results/<scenario>/`. The entrypoint also writes an aggregating
`scenarios-k6/results/index.html` that links to every per-scenario report.

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
