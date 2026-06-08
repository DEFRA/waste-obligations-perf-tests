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
fi

REPO_LOCATION=$(cd "$(dirname "$0")" && pwd)
K6_SCENARIOS=${REPO_LOCATION}/scenarios
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

test_exit_code=0
for script in $scenario_files; do
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
  single=$?
  cat "$log_file"
  if [ "$single" -ne 0 ]; then
    echo "FAILED: $rel (exit $single)"
    test_exit_code=1
  fi
done

# Aggregate top-level pointer index so the artifact has an index.html entry point
INDEX="${K6_RESULTS}/index.html"
{
  echo "<!doctype html><html><head><meta charset='utf-8'><title>K6 results</title>"
  echo "<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem}li{margin:.4rem 0}</style>"
  echo "</head><body><h1>K6 results</h1><ul>"
  find "$K6_RESULTS" -name 'summary.html' -type f | sort | while read -r f; do
    rel=${f#${K6_RESULTS}/}
    echo "<li><a href=\"${rel}\">${rel%/summary.html}</a></li>"
  done
  echo "</ul></body></html>"
} > "$INDEX"

if [ "$CI" = "true" ]; then
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

echo "If running locally via docker, visit http://localhost:8080 to see the report"

exit $test_exit_code
