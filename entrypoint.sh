#!/bin/sh

# Orchestrates the selected K6, Lighthouse, and browser-load workloads and
# emits a single results/index.html linking to their aggregated reports. The
# CDP Portal runs this image and S3-uploads everything under results/ in one
# shot.

REPO_LOCATION=$(cd "$(dirname "$0")" && pwd)

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
  all|k6|lighthouse|browser-load)
    ;;
  *)
    echo "Error: unknown PROFILE '$PROFILE_VALUE'. Expected one of: all, k6, lighthouse, browser-load" >&2
    exit 2
    ;;
esac

export PROFILE="$PROFILE_VALUE"
echo "profile: $PROFILE"

# Each sub-entrypoint must NOT run its own S3 upload or open a browser — the
# root entrypoint owns both at the unified level.
export UNIFIED_RUN=true

BACKEND_DIR="${REPO_LOCATION}/scenarios/backend"
FRONTEND_DIR="${REPO_LOCATION}/scenarios/frontend"
K6_ENTRYPOINT="${BACKEND_DIR}/entrypoint.sh"
FRONTEND_ENTRYPOINT="${FRONTEND_DIR}/entrypoint.sh"
UNIFIED_RESULTS="${REPO_LOCATION}/results"

rm -rf "$UNIFIED_RESULTS"
mkdir -p "$UNIFIED_RESULTS/backend" "$UNIFIED_RESULTS/frontend"

k6_exit=0
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
