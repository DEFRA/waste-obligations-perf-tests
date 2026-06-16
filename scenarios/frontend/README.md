# waste-obligations-perf-tests — Frontend (Lighthouse)

Lighthouse frontend performance audits for the CSOC (Certificate of Compliance)
submission flow. Sits alongside the K6 API tests at `../backend/`.

## What it audits

Playwright signs in via DefraID (using the same flow as
`waste-obligations-journey-tests`), walks the CSOC click-through, and runs a
Lighthouse desktop `navigation`-mode audit against each captured URL:

| Step | How reached | Heading checked |
| --- | --- | --- |
| `csoc-about` | `signIn()` navigates straight to `/compliance/<orgId>/certificate?year=YYYY` after auth | "About your certificate of compliance" |
| `csoc-submission` | Click "Continue" on the About page | "Check and submit your YYYY certificate of compliance" |
| `csoc-view` | Fill the full-name field and click "Confirm and submit" | "YYYY certificate of compliance" (view page) |
| `csoc-success` | `page.goto('/compliance/<orgId>/certificate/success?year=YYYY')` | "YYYY certificate of compliance" (success page) |

Each run performs a real backend submission. To keep it re-runnable, the
runner first PATCHes any existing `Submitted` declarations for the target
org/year back to `Cancelled` (see [Pre-run reset](#pre-run-reset)).

## Layout

```
scenarios/frontend/
├── lib/
│   ├── config.js        baseUrl, backendBaseUrl, CSOC step list, audit options, threshold floor
│   ├── auth.js          signIn(page) — mirrors journey-tests auth.setup.js
│   ├── api-reset.js     PATCH-to-Cancelled pre-run reset (mirrors journey-tests api helper)
│   └── report-index.js  writes results/index.html (score + LCP/FCP/SI/TBT/CLS table)
└── tests/
    └── csoc-flow.js     reset → auth → walk flow → audit each captured URL
```

Per-step output: `results/<step>/report.html` + `report.json`. Top-level
`results/index.html` aggregates scores across all steps.

## Local run (host Node)

1. Install Node 22.13.1+ and `npm ci` (downloads Chromium via Playwright).
2. Copy `env.sh.template` → `env.sh`, fill `EPR_USER_EMAIL` and
   `EPR_USER_PASSWORD`.
3. Run:
   ```sh
   ./entrypoint.sh
   ```

The aggregated `results/index.html` opens in the browser when `CI=false`.

## Local run (Docker)

```sh
docker build -t waste-obligations-lighthouse scenarios/frontend/
docker run --rm \
  -e ENVIRONMENT=perf-test \
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
| `dev` | `https://rwd-dev9.azure.defra.cloud` |
| `tst1` | `https://rwd-tst1.azure.defra.cloud` |
| `perf-test` | `https://rwd-perf-test.azure.defra.cloud` (default) |

For any environment not in this table, set `EPR_BASE_URL` directly.

## Authentication

Mirrors `waste-obligations-journey-tests/auth/auth.setup.js`: goto
`/report-data` → wait for B2C redirects → branch on the `/error` path
(click "Sign in") → fill email/password → submit → wait for
"Account home -" heading.

The journey-tests **does not** ship credentials with the repo; the same
applies here. Provide them via `env.sh` locally or via CDP Portal-injected
env vars in production runs.

## Pre-run reset

`lib/api-reset.js` cancels every `Submitted` declaration on `EPR_ORG_ID` for
the current `EPR_OBLIGATION_YEAR` before the UI walk starts, so the flow can
re-submit cleanly on every run. It mirrors
`waste-obligations-journey-tests/utils/waste-obligations-api.js` — same
backend endpoints, same basic-auth credentials.

Required env vars (see `env.sh.template`):

| Var | Purpose |
| --- | --- |
| `EPR_ORG_ID` | Org whose declarations are reset / submitted to |
| `WASTE_OBLIGATION_USERNAME` / `WASTE_OBLIGATION_PASSWORD` | Backend basic-auth |
| `WASTE_OBLIGATION_SUBMITTER_ID` / `WASTE_OBLIGATION_SUBMITTER_EMAIL` | User stamped on the cancellation |

Optional:

| Var | Default |
| --- | --- |
| `EPR_OBLIGATION_YEAR` | Current calendar year |
| `EPR_BACKEND_BASE_URL` | `https://waste-obligations.{env}.cdp-int.defra.cloud` derived from `ENVIRONMENT` |

## Performance floor

`PERFORMANCE_FLOOR` (default `0.5`) is the minimum Lighthouse `performance`
category score (0-1 range) for the run to exit zero. Any step below the
floor causes a non-zero exit code so CDP Portal surfaces the regression.

## Pipeline

The existing `.github/workflows/publish.yml` builds the **root** `Dockerfile`
(K6). It does not build this folder's Dockerfile yet. To enable CI builds of
the Lighthouse image, add a workflow modelled on `publish.yml` that runs
`docker build scenarios/frontend/` and pushes the image to ECR — then
register it with the CDP Portal as a separate test runner. Credentials are
injected by the portal at run time, exactly as for the K6 runner.
