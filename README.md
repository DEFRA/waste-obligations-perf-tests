# waste-obligations-perf-tests

A JMeter based test runner for the CDP Platform.

- [Licence](#licence)
  - [About the licence](#about-the-licence)

## Build

Test suites are built automatically by the [.github/workflows/publish.yml](.github/workflows/publish.yml) action whenever a change are committed to the `main` branch.
A successful build results in a Docker container that is capable of running your tests on the CDP Platform and publishing the results to the CDP Portal.

## Run

The performance test suites are designed to be run from the CDP Portal.
The CDP Platform runs test suites in much the same way it runs any other service, it takes a docker image and runs it as an ECS task, automatically provisioning infrastructure as required.

## Local Running

### Using the Entrypoint Script

The repository provides an entrypoint script for running JMeter tests on the command line.

**Important**: The script sources `env.sh` automatically, so you must set all environment variables in the `env.sh` file rather than exporting them in the command line. Copy `env.sh.template` to `env.sh` and fill in `WASTE_OBLIGATION_USERNAME` / `WASTE_OBLIGATION_PASSWORD`.

```bash
# Run single test (uses TEST_SCENARIO from env.sh)
./entrypoint.sh

# Run all tests (set TEST_SCENARIO=all in env.sh)
./entrypoint.sh
```

You will need jMeter installed locally. Alternatively, run with Docker instead.

### Using Docker

The performance tests can be run within Docker.

Running against a local service that is not already deployed to CDP is currently not supported but it could be with some further changes. We would need an IDP to get an access token for example.

**Important**: Configure the service environment variables as per template file [./compose/perf-tests.env.template](./compose/perf-tests.env.template) and build. The values for the env file are the same as those used in `env.sh`.

Build, if needed, separately.

```bash
docker compose build --no-cache perf-tests
```

Run the following, which will start the tests automatically against the environment you have configured.

```bash
docker compose up --build
```

Once run, observe the results by visiting http://localhost:8080 to see the jMeter report.

You can also access the results locally in the ./results folder once execution is complete.

## Choosing a runner (JMeter or K6)

The same `entrypoint.sh` drives both runners. Pick one via the `TEST_RUNNER`
env var in `env.sh` (or the compose file):

- `TEST_RUNNER=jmeter` (default) — runs `.jmx` files under `scenarios/`.
- `TEST_RUNNER=k6` — delegates to `scenarios-k6/entrypoint.sh`, which runs
  `.js` files under `scenarios-k6/scenarios/` and writes an HTML report
  (`scenarios-k6/results/summary.html`) plus JUnit XML.
- `TEST_RUNNER=both` — runs JMeter first, then K6. In CI mode K6 artefacts
  are uploaded to `${RESULTS_OUTPUT_S3_PATH}/k6` so they don't overwrite the
  JMeter ones.

`TEST_SCENARIO` is interpreted by whichever runner is active. See
[`scenarios-k6/README.md`](./scenarios-k6/README.md) for the K6 layout.

## Scenarios

Located under `scenarios/`, grouped by feature:

- `get-compliance-declarations/baseline-test.jmx` — single-thread, single-iteration smoke run against `GET /organisations/{orgId}/compliance-declarations` with no filters. Confirms auth + endpoint shape (`$.PageInfo` present, response time under 2s).
- `get-compliance-declarations/load-test.jmx` — 20 threads, 30s ramp, 60s duration, same endpoint with the full filter set (`obligationYear`, `status`, `organisationName`, `pageSize`, `page`). Stresses the query path used by the admin/regulator UI.

Both scenarios authenticate via HTTP Basic auth. `entrypoint.sh` base64-encodes `$WASTE_OBLIGATION_USERNAME:$WASTE_OBLIGATION_PASSWORD` once at startup and passes it to JMeter as `-Jauth_token`, which the scenarios then send as `Authorization: Basic ${__P(auth_token)}`.

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
