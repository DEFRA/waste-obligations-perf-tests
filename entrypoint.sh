#!/bin/sh

# Orchestrates the selected K6, Lighthouse, and browser-load workloads and
# emits a single results/index.html linking to their aggregated reports. The
# CDP Portal runs this image and S3-uploads everything under results/ in one
# shot.

REPO_LOCATION=$(cd "$(dirname "$0")" && pwd)
LOAD_TEST_TASK_STARTED_AT=$(node -e 'console.log(Date.now())')
LOAD_TEST_RUN_LEASE_LIB="${REPO_LOCATION}/lib/load-test-run-lease.sh"

if [ -f "${REPO_LOCATION}/env.sh" ]; then
  echo "Sourcing ${REPO_LOCATION}/env.sh"
  . "${REPO_LOCATION}/env.sh"
fi

if [ -n "${PROFILE:-}" ]; then
  PROFILE_VALUE="$PROFILE"
elif [ "${LIGHTHOUSE_SKIP:-false}" = "true" ]; then
  # Before PROFILE existed, this flag was intended to run the browser load
  # test without Lighthouse. Treat it that way during the migration rather
  # than preserving the root entrypoint's accidental K6-only behaviour.
  echo "LIGHTHOUSE_SKIP is deprecated; use PROFILE=browser-load"
  PROFILE_VALUE="browser-load"
else
  PROFILE_VALUE="all"
fi

case "$PROFILE_VALUE" in
  all|k6|lighthouse|browser-load|unsubmitted|unsubmitted-journey)
    ;;
  *)
    echo "Error: unknown PROFILE '$PROFILE_VALUE'. Expected one of: all, k6, lighthouse, browser-load, unsubmitted, unsubmitted-journey" >&2
    exit 2
    ;;
esac

export PROFILE="$PROFILE_VALUE"
case "$PROFILE" in
  unsubmitted|unsubmitted-journey)
    export LOAD_TEST_RUN_DEADLINE_MS="$(node "$REPO_LOCATION/lib/polling-budget.mjs" start "$LOAD_TEST_TASK_STARTED_AT")"
    [ -n "$LOAD_TEST_RUN_DEADLINE_MS" ] || exit 1
    ;;
esac
echo "profile: $PROFILE"

if [ ! -f "$LOAD_TEST_RUN_LEASE_LIB" ]; then
  echo "Error: load-test run lease helper is missing: $LOAD_TEST_RUN_LEASE_LIB" >&2
  exit 1
fi

. "$LOAD_TEST_RUN_LEASE_LIB"
cleanup_load_test_run() {
  trap '' INT TERM
  if [ -n "${deadline_watchdog_pid:-}" ]; then
    kill "$deadline_watchdog_pid" 2>/dev/null || true
    wait "$deadline_watchdog_pid" 2>/dev/null || true
  fi
  owned_cleanup_failed=0
  for owned_pid in "${frontend_pid:-}" "${polling_pid:-}" "${initialisation_pid:-}" "${api_pid:-}"; do
    if [ -n "$owned_pid" ]; then kill "$owned_pid" 2>/dev/null || true; fi
  done
  for owned_group_file in "${frontend_group_file:-}" "${polling_group_file:-}" "${initialisation_group_file:-}" "${api_group_file:-}"; do
    if [ -n "$owned_group_file" ]; then
      node "$REPO_LOCATION/lib/owned-workload.mjs" stop "$owned_group_file" "$EPR_LOAD_TEST_RUN_ID" || owned_cleanup_failed=1
    fi
  done
  if [ "$owned_cleanup_failed" -ne 0 ]; then
    if [ -n "${LOAD_TEST_RUN_LEASE_HEARTBEAT_PID:-}" ]; then
      kill "$LOAD_TEST_RUN_LEASE_HEARTBEAT_PID" 2>/dev/null || true
      wait "$LOAD_TEST_RUN_LEASE_HEARTBEAT_PID" 2>/dev/null || true
    fi
    echo "Owned workload cleanup failed; the run lease will expire instead of being released while a workload may still be active." >&2
    trap - EXIT
    exit 1
  fi
  for owned_pid in "${frontend_pid:-}" "${polling_pid:-}" "${initialisation_pid:-}" "${api_pid:-}"; do
    if [ -n "$owned_pid" ]; then wait "$owned_pid" 2>/dev/null || true; fi
  done
  if [ "${load_test_lease_acquired:-false}" = "true" ]; then release_load_test_run_lease; fi
}
trap 'cleanup_load_test_run' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

case "$PROFILE" in
  unsubmitted|unsubmitted-journey)
    node "$REPO_LOCATION/lib/polling-budget.mjs" watch "$LOAD_TEST_RUN_DEADLINE_MS" "$$" &
    deadline_watchdog_pid=$!
    ;;
esac
if ! acquire_load_test_run_lease; then exit 1; fi
load_test_lease_acquired=true

case "$PROFILE" in
  unsubmitted|unsubmitted-journey)
    export AUTH_TOKEN="${AUTH_TOKEN:-$(printf '%s:%s' "$WASTE_OBLIGATION_USERNAME" "$WASTE_OBLIGATION_PASSWORD" | base64 | tr -d '\n')}"
    export LOAD_TEST_USER_COUNT="${LOAD_TEST_USER_COUNT:-500}"
    export LOAD_TEST_CATALOGUE_PATH="${REPO_LOCATION}/results/polling-catalogue.json"
    rm -rf "${REPO_LOCATION}/results"
    mkdir -p "${REPO_LOCATION}/results"
    export LOAD_TEST_CONFIGURATION_PATH="$REPO_LOCATION/results/run-configuration.json"
    if [ "$PROFILE" = "unsubmitted-journey" ]; then
      export LOAD_TEST_API_CATALOGUE_PATH="$REPO_LOCATION/results/api-catalogue.json"
      export LOAD_TEST_API_RESULTS_DIR="$REPO_LOCATION/results/get-unsubmitted-organisations"
      export LOAD_TEST_API_STOP_FILE="$REPO_LOCATION/results/api-session-stop"
      export LOAD_TEST_START_FILE="$REPO_LOCATION/results/workloads-start.txt"
    fi
    initialisation_group_file="$REPO_LOCATION/results/initialisation-process-group.json"
    node "$REPO_LOCATION/lib/owned-workload.mjs" run "$initialisation_group_file" "$EPR_LOAD_TEST_RUN_ID" "$REPO_LOCATION" node lib/unsubmitted-polling.mjs &
    initialisation_pid=$!
    if [ "$PROFILE" = "unsubmitted-journey" ]; then
      # API measurements start after stub seeding, while service hydration and
      # existing readiness/authentication continue. Do not wait for 500 hydrated IDs.
      while [ ! -f "$LOAD_TEST_API_CATALOGUE_PATH" ]; do
        if ! kill -0 "$initialisation_pid" 2>/dev/null; then
          wait "$initialisation_pid" || exit 1
          echo "Initialisation ended without an API catalogue" >&2
          exit 1
        fi
        sleep 1
      done
      cat >"$REPO_LOCATION/results/index.html" <<'HTML'
<!doctype html><html lang="en"><meta charset="utf-8"><title>Unsubmitted session in progress</title>
<h1>Unsubmitted performance session — incomplete</h1>
<p>The session is running or ended before final aggregation. This page does not establish a passing result.</p>
<p><a href="get-unsubmitted-organisations/index.html">API baseline and A/B reports</a></p>
<p><a href="backend/unsubmitted-polling/summary.html">Existing polling report</a></p>
<p><a href="frontend/index.html">Browser journey reports</a></p></html>
HTML
      api_group_file="$REPO_LOCATION/results/api-process-group.json"
      node "$REPO_LOCATION/lib/owned-workload.mjs" run "$api_group_file" "$EPR_LOAD_TEST_RUN_ID" "$REPO_LOCATION" node lib/unsubmitted-performance.mjs &
      api_pid=$!
    fi
    wait "$initialisation_pid" || exit 1
    initialisation_pid=""
    export LOAD_TEST_OBLIGATION_YEAR="$(node -e 'console.log(require(process.argv[1]).year)' "$LOAD_TEST_CATALOGUE_PATH")"
    export LOAD_TEST_POLL_DURATION="$(node -e 'console.log(require(process.argv[1]).timing.measuredDurationMilliseconds + "ms")' "$LOAD_TEST_CATALOGUE_PATH")"
    ;;
esac

# Each sub-entrypoint must NOT run its own S3 upload or open a browser — the
# root entrypoint owns both at the unified level.
export UNIFIED_RUN=true

BACKEND_DIR="${REPO_LOCATION}/scenarios/backend"
FRONTEND_DIR="${REPO_LOCATION}/scenarios/frontend"
K6_ENTRYPOINT="${BACKEND_DIR}/entrypoint.sh"
FRONTEND_ENTRYPOINT="${FRONTEND_DIR}/entrypoint.sh"
UNIFIED_RESULTS="${REPO_LOCATION}/results"

case "$PROFILE" in
  unsubmitted|unsubmitted-journey) ;;
  *) rm -rf "$UNIFIED_RESULTS" ;;
esac
mkdir -p "$UNIFIED_RESULTS/backend" "$UNIFIED_RESULTS/frontend"

k6_exit=0
api_exit=0
frontend_exit=0

run_backend() {
  echo ""
  echo "============================================================"
  echo "Backend (K6) phase"
  echo "============================================================"
  if [ -x "$K6_ENTRYPOINT" ]; then
    (cd "$BACKEND_DIR" && "$K6_ENTRYPOINT") || k6_exit=$?
    if [ -d "${BACKEND_DIR}/results" ]; then
      cp -R "${BACKEND_DIR}/results/." "$UNIFIED_RESULTS/backend/"
    fi
    if [ -d "${BACKEND_DIR}/logs" ]; then
      cp -R "${BACKEND_DIR}/logs" "$UNIFIED_RESULTS/backend-logs"
    fi
  else
    echo "Skipping backend: $K6_ENTRYPOINT not executable"
  fi
}

run_frontend() {
  echo ""
  echo "============================================================"
  echo "Frontend ($PROFILE) phase"
  echo "============================================================"
  if [ -x "$FRONTEND_ENTRYPOINT" ]; then
    (cd "$FRONTEND_DIR" && "$FRONTEND_ENTRYPOINT") || frontend_exit=$?
    if [ -d "${FRONTEND_DIR}/results" ]; then
      cp -R "${FRONTEND_DIR}/results/." "$UNIFIED_RESULTS/frontend/"
    fi
  else
    echo "Skipping frontend: $FRONTEND_ENTRYPOINT not executable"
  fi
}

case "$PROFILE" in
  unsubmitted|unsubmitted-journey)
    if [ "$PROFILE" = "unsubmitted-journey" ]; then
      export LOAD_TEST_READY_FILE="$UNIFIED_RESULTS/frontend-ready.json"
      export LOAD_TEST_START_FILE="$UNIFIED_RESULTS/workloads-start.txt"
      frontend_group_file="$UNIFIED_RESULTS/frontend-process-group.json"
      node "$REPO_LOCATION/lib/owned-workload.mjs" run "$frontend_group_file" "$EPR_LOAD_TEST_RUN_ID" "$FRONTEND_DIR" "$FRONTEND_ENTRYPOINT" &
      frontend_pid=$!
      barrier_seconds=0
      while [ ! -f "$LOAD_TEST_READY_FILE" ]; do
        if ! kill -0 "$frontend_pid" 2>/dev/null; then
          wait "$frontend_pid" || frontend_exit=$?
          frontend_pid=""
          echo "Frontend failed before the shared workload startup barrier" >&2
          exit 1
        fi
        if [ "$barrier_seconds" -ge "${LOAD_TEST_AUTH_TIMEOUT_SECONDS:-900}" ]; then
          echo "Timed out waiting for frontend authentication" >&2
          exit 1
        fi
        sleep 1
        barrier_seconds=$((barrier_seconds + 1))
      done
      node "$REPO_LOCATION/lib/polling-budget.mjs" check "$LOAD_TEST_CATALOGUE_PATH" || exit 1
      node -e 'require("fs").writeFileSync(process.argv[1], String(Date.now() + 5000))' "$LOAD_TEST_START_FILE"
    fi
    node "$REPO_LOCATION/lib/polling-budget.mjs" check "$LOAD_TEST_CATALOGUE_PATH" || exit 1
    export RESULTS_DIR="$UNIFIED_RESULTS/backend/unsubmitted-polling"
    mkdir -p "$RESULTS_DIR"
    polling_group_file="$UNIFIED_RESULTS/polling-process-group.json"
    node "$REPO_LOCATION/lib/owned-workload.mjs" run "$polling_group_file" "$EPR_LOAD_TEST_RUN_ID" "$BACKEND_DIR" k6 run tests/get-unsubmitted-organisations/polling.js &
    polling_pid=$!
    wait "$polling_pid" || k6_exit=$?
    polling_pid=""
    if [ "$PROFILE" = "unsubmitted-journey" ]; then
      wait "$frontend_pid" || frontend_exit=$?
      frontend_pid=""
      if [ -d "$FRONTEND_DIR/results" ]; then cp -R "$FRONTEND_DIR/results/." "$UNIFIED_RESULTS/frontend/"; fi
      : >"$LOAD_TEST_API_STOP_FILE"
      wait "$api_pid" || api_exit=$?
      api_pid=""
      if [ "$api_exit" -ne 0 ]; then k6_exit=1; fi
    fi
    if [ -f "$UNIFIED_RESULTS/backend/unsubmitted-polling/summary.html" ]; then
      cp "$UNIFIED_RESULTS/backend/unsubmitted-polling/summary.html" "$UNIFIED_RESULTS/backend/index.html"
    fi
    ;;
  all)
    run_backend
    run_frontend
    ;;
  k6)
    run_backend
    ;;
  lighthouse|browser-load)
    run_frontend
    ;;
esac

if ! ensure_load_test_run_lease; then
  echo "Run failed because the exclusive load-test run lease was lost."
  exit 1
fi

# -------- Unified index.html --------
NOW_UTC=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
ENV_LABEL="${ENVIRONMENT:-(unset)}"

k6_count="—"
if [ -f "$UNIFIED_RESULTS/backend/index.html" ]; then
  k6_count=$(find "$UNIFIED_RESULTS/backend" -name 'summary.json' -type f 2>/dev/null | wc -l | tr -d ' ')
fi
frontend_count="—"
if [ -f "$UNIFIED_RESULTS/frontend/index.html" ]; then
  frontend_count=$(find "$UNIFIED_RESULTS/frontend" -type f \( -name 'report.json' -o -name 'load-test-*.json' \) 2>/dev/null | wc -l | tr -d ' ')
fi

k6_status="N/A"
[ -f "$UNIFIED_RESULTS/backend/index.html" ] && {
  if [ "$k6_exit" -eq 0 ]; then k6_status="pass"; else k6_status="fail"; fi
}
frontend_status="N/A"
[ -f "$UNIFIED_RESULTS/frontend/index.html" ] && {
  if [ "$frontend_exit" -eq 0 ]; then frontend_status="pass"; else frontend_status="fail"; fi
}

cat >"$UNIFIED_RESULTS/index.html" <<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Perf results — waste-obligations-perf-tests</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { margin: 0 0 .25rem; }
  .meta { color: #666; font-size: .9rem; margin-bottom: 2rem; }
  .card { display: block; padding: 1.2rem 1.4rem; margin: 0 0 1rem; border: 1px solid #e1e4e8; border-radius: 8px; text-decoration: none; color: inherit; }
  .card:hover { border-color: #0366d6; background: #f6f8fa; }
  .card h2 { margin: 0 0 .35rem; font-size: 1.1rem; color: #0366d6; }
  .card .summary { color: #444; font-size: .92rem; }
  .badge { display: inline-block; padding: .1rem .55rem; border-radius: 10px; font-size: .75rem; font-weight: 600; vertical-align: middle; margin-left: .5rem; }
  .pass { background: #e6f4ea; color: #0a7d32; }
  .fail { background: #fde2e2; color: #c52525; }
  .na { background: #eee; color: #666; }
  .footer { color: #666; font-size: .85rem; margin-top: 2rem; }
</style>
</head>
<body>
<h1>waste-obligations perf results</h1>
<p class="meta">Run at ${NOW_UTC} · ENVIRONMENT=${ENV_LABEL} · PROFILE=${PROFILE}</p>
$(if [ "$PROFILE" = "unsubmitted-journey" ]; then
  api_status=pass
  [ "$api_exit" -ne 0 ] && api_status=fail
  api_label="$api_status"
  [ "${LOAD_TEST_ALLOW_SHORT_SMOKE:-false}" = "true" ] && api_label="SMOKE ${api_status}"
  echo "<a class=\"card\" href=\"get-unsubmitted-organisations/index.html\"><h2>Unsubmitted API — baseline and repeated A/B rounds <span class=\"badge ${api_status}\">${api_label}</span></h2><div class=\"summary\">Separate SLA gates, pagination, observed totals and phase timings. Shortened windows are labelled SMOKE.</div></a>"
fi)

<a class="card" href="backend/index.html">
  <h2>Backend — K6 API load tests
    <span class="badge $(echo "$k6_status" | tr '[:upper:]' '[:lower:]')">${k6_status}</span>
  </h2>
  <div class="summary">${k6_count} scenario(s). Per-scenario summary table, HTML reports, JUnit XML and logs.</div>
</a>

<a class="card" href="frontend/index.html">
  <h2>Frontend — browser performance and load tests
    <span class="badge $(echo "$frontend_status" | tr '[:upper:]' '[:lower:]')">${frontend_status}</span>
  </h2>
  <div class="summary">${frontend_count} report artifact(s). Lighthouse scores and browser-load timing reports, when selected.</div>
</a>

<p class="footer">backend_exit=${k6_exit} · frontend_exit=${frontend_exit}</p>
</body>
</html>
HTML

echo ""
echo "Wrote unified index at $UNIFIED_RESULTS/index.html"

# -------- S3 upload (CI mode) --------
if [ "$CI" = "true" ]; then
  if [ -n "$RESULTS_OUTPUT_S3_PATH" ]; then
    if command -v aws >/dev/null 2>&1; then
      ENDPOINT_ARG=""
      if [ -n "$S3_ENDPOINT" ]; then
        ENDPOINT_ARG="--endpoint-url=$S3_ENDPOINT"
      fi
      aws $ENDPOINT_ARG s3 cp "$UNIFIED_RESULTS" "$RESULTS_OUTPUT_S3_PATH" --recursive
      echo "Results published to $RESULTS_OUTPUT_S3_PATH"
    else
      echo "aws CLI not available, skipping S3 upload"
    fi
  else
    echo "RESULTS_OUTPUT_S3_PATH not set, skipping S3 upload"
  fi
else
  if command -v open >/dev/null 2>&1; then
    echo "Opening unified report in browser..."
    open "$UNIFIED_RESULTS/index.html"
  else
    echo "Unified report at: $UNIFIED_RESULTS/index.html"
  fi
fi

if [ "$k6_exit" -ne 0 ] || [ "$frontend_exit" -ne 0 ]; then
  echo "Run failed: backend_exit=$k6_exit frontend_exit=$frontend_exit"
  exit 1
fi
exit 0
