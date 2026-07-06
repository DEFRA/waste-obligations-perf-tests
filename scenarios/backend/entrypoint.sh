#!/bin/sh

if [ -f "./env.sh" ]; then
  echo "env.sh file found"
  . ./env.sh
else
  echo "env.sh file not found"
fi

check_variable() {
  if [ -z "$1" ]; then
    echo "Error: $2 is not set"
    exit 1
  fi
}

check_variable "$ENVIRONMENT" "ENVIRONMENT"
check_variable "$TEST_SCENARIO" "TEST_SCENARIO"
check_variable "$CI" "CI"
check_variable "$WASTE_OBLIGATION_USERNAME" "WASTE_OBLIGATION_USERNAME"
check_variable "$WASTE_OBLIGATION_PASSWORD" "WASTE_OBLIGATION_PASSWORD"

AUTH_TOKEN=$(printf '%s:%s' "$WASTE_OBLIGATION_USERNAME" "$WASTE_OBLIGATION_PASSWORD" | base64 | tr -d '\n')
export AUTH_TOKEN
export ENVIRONMENT

if [ "$CI" = "true" ]; then
  echo "run_id: $RUN_ID in $ENVIRONMENT"

  # The soak test runs for ~2h and exists to catch memory leaks / connection
  # pool exhaustion during long sustained load. It's intended for local /
  # ad-hoc investigation only — it doesn't belong in the CDP pipeline (would
  # consume the entire pipeline slot even if it fit) and results don't feed
  # back into the release gate. Refuse to run it under CI=true rather than
  # letting a misconfigured job kick off a multi-hour billed run.
  case "$TEST_SCENARIO" in
    */soak.js|soak.js)
      echo "Error: soak tests are local-only. Refusing to run '$TEST_SCENARIO' with CI=true." >&2
      exit 1
      ;;
  esac
fi

REPO_LOCATION=$(cd "$(dirname "$0")" && pwd)
K6_SCENARIOS=${REPO_LOCATION}/tests
K6_RESULTS=${REPO_LOCATION}/results
K6_LOGS=${REPO_LOCATION}/logs

rm -rf "$K6_RESULTS" "$K6_LOGS"
mkdir -p "$K6_RESULTS" "$K6_LOGS"

if [ "$TEST_SCENARIO" = "all" ]; then
  echo "Running all scenarios"
  scenario_files=$(find "$K6_SCENARIOS" -name "*.js" -type f 2>/dev/null)
  if [ -z "$scenario_files" ]; then
    echo "No K6 scripts found in $K6_SCENARIOS"
    exit 1
  fi
else
  scenario_files="${K6_SCENARIOS}/${TEST_SCENARIO}"
  if [ ! -f "$scenario_files" ]; then
    echo "Scenario not found: $scenario_files"
    exit 1
  fi
fi

if [ -n "$HTTP_PROXY" ]; then
  echo "Using HTTP_PROXY=$HTTP_PROXY"
  export HTTP_PROXY
  export HTTPS_PROXY="${HTTPS_PROXY:-$HTTP_PROXY}"
fi

echo "Using K6_SCENARIOS: $K6_SCENARIOS"
echo "Using K6_RESULTS:   $K6_RESULTS"
echo "Using CI:           $CI"
echo "Using ENVIRONMENT:  $ENVIRONMENT"
echo "Using USERNAME:     $(printf '%s' "$WASTE_OBLIGATION_USERNAME" | cut -c1-2)***"

run_scenario() {
  script="$1"
  rel=${script#${K6_SCENARIOS}/}
  scenario_dir=${rel%.js}
  result_dir="${K6_RESULTS}/${scenario_dir}"
  mkdir -p "$result_dir"

  echo ""
  echo "================================================================"
  echo "Running: $rel"
  echo "Results: $result_dir"
  echo "================================================================"

  log_file="${K6_LOGS}/$(echo "$scenario_dir" | tr '/' '_').log"
  RESULTS_DIR="${result_dir}" k6 run \
    --summary-export "${result_dir}/summary-export.json" \
    "$script" >"$log_file" 2>&1
  rc=$?
  cat "$log_file"
  if [ "$rc" -ne 0 ]; then
    echo "FAILED: $rel (exit $rc)"
  fi
  return $rc
}

test_exit_code=0

if [ "$TEST_SCENARIO" = "all" ]; then
  baseline_files=$(printf '%s\n' $scenario_files | grep '/baseline\.js$' | sort)
  # soak.js is excluded — it runs for 2h alone and would blow the pipeline
  # timeout. Trigger it explicitly with TEST_SCENARIO=<endpoint>/soak.js.
  load_files=$(printf '%s\n' $scenario_files | grep -v '/baseline\.js$' | grep -v '/soak\.js$' | sort)

  echo ""
  echo "================================================================"
  echo "Phase 1/2 — baselines (gate)"
  echo "================================================================"
  baseline_failed=0
  for script in $baseline_files; do
    if ! run_scenario "$script"; then
      test_exit_code=1
      baseline_failed=1
      echo ""
      echo "Baseline failed — aborting before load tests."
      break
    fi
  done

  if [ "$baseline_failed" -eq 0 ]; then
    echo ""
    echo "================================================================"
    echo "Phase 2/2 — load tests"
    echo "================================================================"
    for script in $load_files; do
      if ! run_scenario "$script"; then
        test_exit_code=1
      fi
    done
  fi
else
  for script in $scenario_files; do
    if ! run_scenario "$script"; then
      test_exit_code=1
    fi
  done
fi

# Build an aggregated index.html with summary cards, table, and charts across
# all scenarios. Uses jq to read each scenario's summary.json; falls back to a
# bare link list if jq isn't installed. Chart.js, CSS, and JS are vendored under
# lib/report/ and copied into the results dir so the report is self-contained.
INDEX="${K6_RESULTS}/index.html"
NOW_UTC=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

REPORT_LIB="${REPO_LOCATION}/lib/report"
for asset in chart.umd.min.js report.css report.js; do
  if [ -f "${REPORT_LIB}/${asset}" ]; then
    cp "${REPORT_LIB}/${asset}" "${K6_RESULTS}/${asset}"
  fi
done

DATA_JSON='[]'
if command -v jq >/dev/null 2>&1; then
  TMPDATA=$(mktemp)
  find "$K6_RESULTS" -name 'summary.json' -type f | sort | while read -r summary; do
    scenario_rel=$(dirname "${summary#${K6_RESULTS}/}")
    jq -c --arg name "$scenario_rel" '{
      name: $name,
      pass: (([.metrics[]?.thresholds // {} | to_entries[]?.value.ok // true] | all)
             and ((.metrics.checks.values.fails // 0) == 0)),
      vusMax: (.metrics.vus_max.values.max // .metrics.vus_max.values.value),
      iters: .metrics.iterations.values.count,
      reqs: .metrics.http_reqs.values.count,
      reqRate: .metrics.http_reqs.values.rate,
      avg: .metrics.http_req_duration.values.avg,
      p95: .metrics.http_req_duration.values."p(95)",
      failRate: .metrics.http_req_failed.values.rate,
      checkRate: .metrics.checks.values.rate
    }' "$summary"
  done >"$TMPDATA"
  DATA_JSON=$(jq -s '.' <"$TMPDATA")
  rm -f "$TMPDATA"
fi

{
  cat <<HTML_HEAD
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>K6 results — waste-obligations-perf-tests</title>
<link rel="stylesheet" href="report.css">
</head>
<body>
<h1>K6 results</h1>
<p class="meta">Run at ${NOW_UTC} · ENVIRONMENT=${ENVIRONMENT}</p>

<div id="counters" class="counters"></div>

<h2>Scenarios</h2>
<div class="panel" style="padding:0;overflow:hidden;">
<table>
  <thead>
    <tr>
      <th>Scenario</th>
      <th>Status</th>
      <th class="num">VUs max</th>
      <th class="num">Iters</th>
      <th class="num">Reqs</th>
      <th class="num">Avg</th>
      <th class="num">p(95)</th>
      <th class="num">Fail %</th>
      <th class="num">Checks %</th>
    </tr>
  </thead>
  <tbody>
HTML_HEAD

  find "$K6_RESULTS" -name 'summary.json' -type f | sort | while read -r summary; do
    scenario_rel=$(dirname "${summary#${K6_RESULTS}/}")
    if command -v jq >/dev/null 2>&1; then
      jq -r --arg name "$scenario_rel" '
        def pass:
          ([.metrics[]?.thresholds // {} | to_entries[]?.value.ok // true] | all)
          and ((.metrics.checks.values.fails // 0) == 0);
        def num(v): if v == null then "—" else (v | tostring) end;
        def ms(v): if v == null then "—" else ((v * 100 | floor) / 100 | tostring) + " ms" end;
        def pct(v): if v == null then "—" else ((v * 10000 | floor) / 100 | tostring) + "%" end;
        (if pass then "pass" else "fail" end) as $cls |
        (if pass then "✓ pass" else "✗ fail" end) as $label |
        "<tr class=\"" + $cls + "\">" +
          "<td><a href=\"" + $name + "/summary.html\">" + $name + "</a></td>" +
          "<td class=\"status\">" + $label + "</td>" +
          "<td class=\"num\">" + num(.metrics.vus_max.values.max // .metrics.vus_max.values.value) + "</td>" +
          "<td class=\"num\">" + num(.metrics.iterations.values.count) + "</td>" +
          "<td class=\"num\">" + num(.metrics.http_reqs.values.count) + "</td>" +
          "<td class=\"num\">" + ms(.metrics.http_req_duration.values.avg) + "</td>" +
          "<td class=\"num\">" + ms(.metrics.http_req_duration.values."p(95)") + "</td>" +
          "<td class=\"num\">" + pct(.metrics.http_req_failed.values.rate) + "</td>" +
          "<td class=\"num\">" + pct(.metrics.checks.values.rate) + "</td>" +
        "</tr>"
      ' "$summary"
    else
      echo "<tr><td><a href=\"${scenario_rel}/summary.html\">${scenario_rel}</a></td><td colspan=\"8\">install jq for per-scenario stats</td></tr>"
    fi
  done

  cat <<HTML_FOOT
  </tbody>
</table>
</div>

<h2>Charts</h2>
<div class="charts-grid">
  <div class="panel chart-card"><h3>Response time — avg &amp; p(95)</h3><div class="chart-wrap"><canvas id="ch-latency"></canvas></div></div>
  <div class="panel chart-card"><h3>Throughput (req/s)</h3><div class="chart-wrap"><canvas id="ch-throughput"></canvas></div></div>
  <div class="panel chart-card"><h3>Failure rate (%)</h3><div class="chart-wrap"><canvas id="ch-fail"></canvas></div></div>
  <div class="panel chart-card"><h3>Check pass rate (%)</h3><div class="chart-wrap"><canvas id="ch-check"></canvas></div></div>
</div>

<p class="footer">Click a scenario name for its full k6 HTML report. Per-scenario summary JSON and JUnit XML are alongside.</p>

<script>window.K6_DATA = ${DATA_JSON};</script>
<script src="chart.umd.min.js"></script>
<script src="report.js"></script>
</body>
</html>
HTML_FOOT
} > "$INDEX"

if [ "$UNIFIED_RUN" = "true" ]; then
  echo "UNIFIED_RUN=true — root entrypoint owns S3 upload + index opening"
elif [ "$CI" = "true" ]; then
  if [ -n "$RESULTS_OUTPUT_S3_PATH" ]; then
    if command -v aws >/dev/null 2>&1; then
      ENDPOINT_ARG=""
      if [ -n "$S3_ENDPOINT" ]; then
        ENDPOINT_ARG="--endpoint-url=$S3_ENDPOINT"
      fi
      aws $ENDPOINT_ARG s3 cp "$K6_RESULTS" "$RESULTS_OUTPUT_S3_PATH" --recursive
      aws $ENDPOINT_ARG s3 cp "$K6_LOGS" "$RESULTS_OUTPUT_S3_PATH/logs" --recursive
      echo "Results published to $RESULTS_OUTPUT_S3_PATH"
    else
      echo "aws CLI not available, skipping S3 upload"
    fi
  else
    echo "RESULTS_OUTPUT_S3_PATH not set, skipping S3 upload"
  fi
else
  echo "All tests completed"
  if command -v open >/dev/null 2>&1; then
    echo "Opening report in browser..."
    open "$INDEX"
  else
    echo "Report index at: $INDEX"
  fi
fi

if [ "$UNIFIED_RUN" != "true" ]; then
  echo "If running locally via docker, visit http://localhost:8080 to see the report"
fi

exit $test_exit_code
