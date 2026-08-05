#!/bin/sh

if [ -f "./env.sh" ]; then
  echo "env.sh file found"
  . ./env.sh
else
  echo "env.sh file not found"
fi

if [ -n "${PROFILE:-}" ]; then
  PROFILE_VALUE="$PROFILE"
elif [ "${LIGHTHOUSE_SKIP:-false}" = "true" ]; then
  # Keep direct local invocations using the old frontend env.sh working while
  # callers move to PROFILE=browser-load.
  echo "LIGHTHOUSE_SKIP is deprecated; use PROFILE=browser-load"
  PROFILE_VALUE="browser-load"
else
  PROFILE_VALUE="all"
fi

case "$PROFILE_VALUE" in
  all|lighthouse|browser-load)
    ;;
  *)
    echo "Error: unknown frontend PROFILE '$PROFILE_VALUE'. Expected one of: all, lighthouse, browser-load" >&2
    exit 2
    ;;
esac

export PROFILE="$PROFILE_VALUE"
echo "profile: $PROFILE"

check_variable() {
  if [ -z "$1" ]; then
    echo "Error: $2 is not set"
    exit 1
  fi
}

check_variable "$ENVIRONMENT" "ENVIRONMENT"
check_variable "$CI" "CI"
check_variable "$WASTE_OBLIGATION_USERNAME" "WASTE_OBLIGATION_USERNAME"
check_variable "$WASTE_OBLIGATION_PASSWORD" "WASTE_OBLIGATION_PASSWORD"
check_variable "$WASTE_OBLIGATION_SUBMITTER_ID" "WASTE_OBLIGATION_SUBMITTER_ID"
check_variable "$WASTE_OBLIGATION_SUBMITTER_EMAIL" "WASTE_OBLIGATION_SUBMITTER_EMAIL"

direct_producer_user_count=0
compliance_scheme_user_count=0
run_direct_producer_lighthouse=false
run_compliance_scheme_lighthouse=false

if [ "$PROFILE" = "all" ] || [ "$PROFILE" = "browser-load" ]; then
  check_variable "$EPR_AZURE_STUB_BASE_URL" "EPR_AZURE_STUB_BASE_URL"
  load_test_user_counts=$(node --input-type=module -e '
    import { loadTestUserMix } from "./lib/load-test-session.js"
    const mix = loadTestUserMix()
    console.log(mix.directProducerUserCount + ":" + mix.complianceSchemeUserCount)
  ') || exit 1
  direct_producer_user_count=${load_test_user_counts%%:*}
  compliance_scheme_user_count=${load_test_user_counts##*:}
fi

if [ "$PROFILE" = "lighthouse" ]; then
  run_direct_producer_lighthouse=true
  run_compliance_scheme_lighthouse=true
elif [ "$PROFILE" = "all" ]; then
  [ "$direct_producer_user_count" -gt 0 ] && run_direct_producer_lighthouse=true
  [ "$compliance_scheme_user_count" -gt 0 ] && run_compliance_scheme_lighthouse=true
fi

if [ "$run_direct_producer_lighthouse" = "true" ] || [ "$direct_producer_user_count" -gt 0 ]; then
  check_variable "$EPR_USER_EMAIL" "EPR_USER_EMAIL"
  check_variable "$EPR_USER_PASSWORD" "EPR_USER_PASSWORD"
  check_variable "$EPR_ORG_ID" "EPR_ORG_ID"
fi

if [ "$run_compliance_scheme_lighthouse" = "true" ] || [ "$compliance_scheme_user_count" -gt 0 ]; then
  check_variable "$EPR_CSO_USER_EMAIL" "EPR_CSO_USER_EMAIL"
  check_variable "$EPR_CSO_USER_PASSWORD" "EPR_CSO_USER_PASSWORD"
  check_variable "$WASTE_OBLIGATION_CSO_ORG_ID" "WASTE_OBLIGATION_CSO_ORG_ID"
fi

if [ "$CI" = "true" ]; then
  echo "run_id: $RUN_ID in $ENVIRONMENT"
fi

REPO_LOCATION=$(cd "$(dirname "$0")" && pwd)
RESULTS_DIR="${REPO_LOCATION}/results"

cd "$REPO_LOCATION" || exit 1

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm ci
fi

echo "Using EPR_BASE_URL: ${EPR_BASE_URL:-(derived from ENVIRONMENT=$ENVIRONMENT)}"
if [ "$PROFILE" = "all" ] || [ "$PROFILE" = "browser-load" ]; then
  echo "Using EPR_AZURE_STUB_BASE_URL: $EPR_AZURE_STUB_BASE_URL"
  echo "Using LOAD_TEST_USER_COUNT: ${LOAD_TEST_USER_COUNT:-40}"
  echo "Using LOAD_TEST_CSO_PERCENTAGE: ${LOAD_TEST_CSO_PERCENTAGE:-75}"
  echo "Using load-test user mix: ${direct_producer_user_count} Direct Producer, ${compliance_scheme_user_count} Compliance Scheme Officer"
fi
if [ "$PROFILE" = "all" ] || [ "$PROFILE" = "lighthouse" ]; then
  echo "Using PERFORMANCE_FLOOR: ${PERFORMANCE_FLOOR:-0.5}"
  [ "$run_direct_producer_lighthouse" = "true" ] && echo "Using Direct Producer username: $(printf '%s' "$EPR_USER_EMAIL" | cut -c1-2)***"
  [ "$run_compliance_scheme_lighthouse" = "true" ] && echo "Using Compliance Scheme Officer username: $(printf '%s' "$EPR_CSO_USER_EMAIL" | cut -c1-2)***"
fi

# Mirrors waste-obligations-journey-tests' default profile — the browser
# reaches the CDP-internal target host directly. Leaving HTTP_PROXY set
# causes Chromium to CONNECT through the egress proxy, which refuses the
# tunnel for cdp-int.defra.cloud and throws ERR_TUNNEL_CONNECTION_FAILED.
# unset HTTP_PROXY HTTPS_PROXY

lighthouse_exit=0
load_test_exit=0
if [ "$run_direct_producer_lighthouse" = "true" ] || [ "$run_compliance_scheme_lighthouse" = "true" ]; then
  echo "--- Lighthouse audit ---"
  lighthouse_account_types=""
  [ "$run_direct_producer_lighthouse" = "true" ] && lighthouse_account_types="dp"
  [ "$run_compliance_scheme_lighthouse" = "true" ] && lighthouse_account_types="${lighthouse_account_types:+$lighthouse_account_types,}cso"
  LIGHTHOUSE_ACCOUNT_TYPES="$lighthouse_account_types" node tests/csoc-flow.js
  lighthouse_exit=$?
fi

if [ "$PROFILE" = "all" ] || [ "$PROFILE" = "browser-load" ]; then
  echo "--- Browser load test ---"
  node tests/csoc-load-test.js
  load_test_exit=$?
fi

# Exit 1 if either phase failed
test_exit_code=0
[ $lighthouse_exit -ne 0 ] && test_exit_code=1
[ $load_test_exit -ne 0 ] && test_exit_code=1

if [ "$UNIFIED_RUN" = "true" ]; then
  echo "UNIFIED_RUN=true — root entrypoint owns S3 upload + index opening"
elif [ "$CI" = "true" ]; then
  if [ -n "$RESULTS_OUTPUT_S3_PATH" ]; then
    if command -v aws >/dev/null 2>&1; then
      ENDPOINT_ARG=""
      if [ -n "$S3_ENDPOINT" ]; then
        ENDPOINT_ARG="--endpoint-url=$S3_ENDPOINT"
      fi
      aws $ENDPOINT_ARG s3 cp "$RESULTS_DIR" "$RESULTS_OUTPUT_S3_PATH" --recursive
      echo "Results published to $RESULTS_OUTPUT_S3_PATH"
    else
      echo "aws CLI not available, skipping S3 upload"
    fi
  else
    echo "RESULTS_OUTPUT_S3_PATH not set, skipping S3 upload"
  fi
else
  if [ -f "${RESULTS_DIR}/index.html" ]; then
    if command -v open >/dev/null 2>&1; then
      open "${RESULTS_DIR}/index.html"
    else
      echo "Report: ${RESULTS_DIR}/index.html"
    fi
  else
    echo "Run aborted before any results were written (exit code $test_exit_code)"
  fi
fi

exit $test_exit_code
