# waste-obligations-perf-tests — Frontend browser tests

Lighthouse performance audits and browser load tests for the CSOC submission
flows. Sits alongside the K6 API tests at `../backend/`.

`PROFILE` selects what this frontend entrypoint runs:

| `PROFILE` | Runs |
| --- | --- |
| `all` (default) | Lighthouse for each account type in the mix, then browser load |
| `lighthouse` | Direct Producer and CSO Lighthouse audits only |
| `browser-load` | Stub-initialised browser load test only |

The root repository entrypoint also accepts `PROFILE=k6`; it does not invoke
this frontend entrypoint for that profile.

## What it audits

Playwright signs in via DefraID (using the same flow as
`waste-obligations-journey-tests`), walks the CSOC click-through, and runs a
Lighthouse desktop and mobile `navigation`-mode audit against each captured
URL for both account types. The Direct Producer steps are:

| Step | How reached                                                                                      | Heading checked |
| --- |--------------------------------------------------------------------------------------------------| --- |
| `direct-producer-about` | `signIn()` navigates straight to `/compliance/producer/<orgId>/certificate?year=YYYY` after auth | "About your certificate of compliance" |
| `direct-producer-submission` | Click "Continue" on the About page                                                               | "Check and submit your YYYY certificate of compliance" |
| `direct-producer-view` | Fill the full-name field and click "Confirm and submit"                                          | "YYYY certificate of compliance" (view page) |
| `direct-producer-success` | `page.goto('/compliance/producer/<orgId>/certificate/success?year=YYYY')`                        | "YYYY certificate of compliance" (success page) |

Each run performs a real backend submission. To keep it re-runnable, the
runner cancels any existing non-cancelled declarations for each audited
organisation/year (see [Declaration cleanup](#declaration-cleanup)). The CSO
flow follows the corresponding `cso-about`, `cso-submission`, `cso-success`,
and `cso-view` statement pages.

## Layout

```
scenarios/frontend/
├── lib/
│   ├── config.js        baseUrl, backendBaseUrl, producer step list, audit options, threshold floor
│   ├── auth.js          signInAs(page) — mirrors journey-tests auth.setup.js
│   ├── api-reset.js     PATCH-to-Cancelled helper (mirrors journey-tests API helper)
│   └── report-index.js  writes results/index.html (score + LCP/FCP/SI/TBT/CLS table)
└── tests/
    └── csoc-flow.js     reset → auth → walk flow → audit each captured URL
```

Per-step output: `results/<step>/report.html` + `report.json`. Top-level
`results/index.html` aggregates scores across all steps.

## Local run (host Node)

1. Install Node 22.13.1+ and `npm ci` (downloads Chromium via Playwright).
2. Copy `env.sh.template` → `env.sh`, fill the credentials for the account
   types selected by the profile.
3. Run the desired profile:
   ```sh
   PROFILE=browser-load ./entrypoint.sh
   ```

Use `PROFILE=lighthouse` or `PROFILE=all` when appropriate. The aggregated
`results/index.html` opens in the browser when `CI=false`.

## Local run (Docker)

```sh
docker build -t waste-obligations-lighthouse scenarios/frontend/
docker run --rm \
  -e ENVIRONMENT=perf-test \
  -e PROFILE=browser-load \
  -e CI=false \
  -e EPR_USER_EMAIL=... \
  -e EPR_USER_PASSWORD=... \
  -v "$(pwd)/scenarios/frontend/results:/opt/perftest-lighthouse/results" \
  waste-obligations-lighthouse
```

## Environments

`ENVIRONMENT` selects the frontend host:

| Value | URL |
| --- | --- |
| `dev` | `https://waste-obligations-frontend.dev.cdp-int.defra.cloud` |
| `tst1` | `https://waste-obligations-frontend.tst.cdp-int.defra.cloud` |
| `perf-test` | `https://waste-obligations-frontend.perf-test.cdp-int.defra.cloud` (default) |

For any environment not in this table, set `EPR_BASE_URL` directly.

## Authentication

Mirrors `waste-obligations-journey-tests/auth/auth.setup.js`: goto
`/report-data` → wait for B2C redirects → branch on the `/error` path
(click "Sign in") → fill email/password → submit → wait for
"Account home -" heading.

The journey-tests **does not** ship credentials with the repo; the same
applies here. Provide them via `env.sh` locally or via CDP Portal-injected
env vars in production runs.

## Declaration cleanup

`lib/api-reset.js` cancels every non-cancelled declaration for each seeded
organisation included in the Lighthouse profile, for the hardcoded obligation
year (2026). The browser load test instead cancels declarations for each
generated organisation after its virtual user's browser context closes. It mirrors
`waste-obligations-journey-tests/utils/waste-obligations-api.js` — same
backend endpoints, same basic-auth credentials.

For `PROFILE=browser-load` or `PROFILE=all`, provide the variables for each
account type included in the configured mix (see `env.sh.template`):

| Var | Purpose |
| --- | --- |
| `EPR_ORG_ID` | Direct-producer organisation used to enter the authenticated flows; Lighthouse declarations are reset here |
| `WASTE_OBLIGATION_CSO_ORG_ID` | Seeded compliance-scheme external ID used to enter the authenticated statement flow |
| `EPR_USER_EMAIL` / `EPR_USER_PASSWORD` | Direct-producer login credentials |
| `EPR_CSO_USER_EMAIL` / `EPR_CSO_USER_PASSWORD` | Compliance-scheme login credentials |
| `WASTE_OBLIGATION_USERNAME` / `WASTE_OBLIGATION_PASSWORD` | Backend basic-auth |
| `WASTE_OBLIGATION_SUBMITTER_ID` / `WASTE_OBLIGATION_SUBMITTER_EMAIL` | User stamped on the cancellation |

Optional:

| Var | Default |
| --- | --- |
| `EPR_BACKEND_BASE_URL` | `https://waste-obligations.{env}.cdp-int.defra.cloud` derived from `ENVIRONMENT` |

`PROFILE=lighthouse` requires both Direct Producer and CSO credentials and
their seeded organisation IDs. Run it through the repository-root entrypoint
so it participates in the Azure-stub run lease that serialises all profiles.

## Browser load-test allocations

`tests/csoc-load-test.js` authenticates once for each user type and shares each
browser session with that type's virtual users. Before those users start, it
calls the Azure stub's load-test session endpoint, which resets prior
allocations and creates exactly the requested direct-producer and
compliance-scheme organisation allocations.

Set `EPR_AZURE_STUB_BASE_URL` to the stub host. `LOAD_TEST_USER_COUNT` defaults
to `40` and `LOAD_TEST_CSO_PERCENTAGE` defaults to `75`, so the default run
creates 10 direct-producer and 30 compliance-scheme virtual users. The runner
adds `X-EPR-Load-Test-Session=<run-id>:<user-index>` to each browser context and
uses that type's allocated organisation ID for its journey.
`LOAD_TEST_USER_ITERATIONS` defaults to `1`. Raising it repeats the complete
journey sequentially for each virtual user without increasing browser
concurrency. Each repetition uses a fresh browser context seeded from the
captured authenticated state, but keeps the same allocation and correlation
header. A user stops after its first failed repetition; any failed browser step
makes the profile fail.

After every virtual user completes its requested repetitions, the runner
cancels declarations for that allocated organisation before the allocation is
replaced by the next run. More iterations therefore lengthen both the journey
run and the final cleanup phase.
The producer session starts on the seeded direct-producer organisation; the
scheme session starts on the seeded compliance-scheme external ID. The latter
then follows the statement route, including the Regulation 43 confirmation.
At 0% or 100%, the unused account type does not need credentials or a seeded
organisation ID and is not authenticated.

The target frontend deployment must set
`LOAD_TEST_HEADER_FORWARDING_ENABLED=true`; outside the load-test environment
the default remains disabled and the browser header is ignored.

Both applications must use the route groups exposed by the Azure stub. For a
stub host `https://stub.example`, configure:

| Application | Setting | Value |
| --- | --- | --- |
| Frontend | `BACKEND_ACCOUNT_API_BASE_URL` | `https://stub.example/epr-backend-account-microservice/api/` |
| Frontend | `WASTE_ORGANISATIONS_API_BASE_URL` | `https://stub.example/waste-organisations` |
| Waste Obligations | `WasteOrganisations__BaseAddress` | `https://stub.example/waste-organisations/` |
| Waste Obligations | `PrnCommonBackend__BaseAddress` | `https://stub.example/epr-prn-common-backend/` |
| Waste Obligations | `PrnCommonBackend__TokenEndpoint` | `https://stub.example/oauth2/v2.0/token` |

The trailing slash on the two Waste Obligations base addresses is required:
that service uses relative downstream paths. The stub does not validate client
credentials, but the corresponding required configuration values must still be
present for each application to start.

The Azure stub stores one active allocation set. The root runner obtains a
matching run lease before initialising it, releases it in its exit handler, and
renews the lease while the selected profile runs. Do not invoke this frontend
entrypoint directly against a shared stub; use the repository-root entrypoint
so K6, Lighthouse and browser-load share that coordination.

## Performance floor

`PERFORMANCE_FLOOR` (default `0.5`) is the minimum Lighthouse `performance`
category score (0-1 range) for the run to exit zero. Any step below the
floor causes a non-zero exit code so CDP Portal surfaces the regression.

## Pipeline

The existing `.github/workflows/publish.yml` builds the root Dockerfile. Use
the CDP Portal `PROFILE` field to select `k6`, `lighthouse`, `browser-load`,
or `all` at run time. The standalone frontend Dockerfile remains useful for
local or separately deployed browser-only execution.
