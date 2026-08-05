#!/bin/sh

# Coordinates a complete performance-test run through the Azure stub. The
# allocation session used by browser-load is scoped to this same run ID.

load_test_run_lease_base_url() {
  if [ -z "${EPR_AZURE_STUB_BASE_URL:-}" ]; then
    echo "Error: EPR_AZURE_STUB_BASE_URL is required to coordinate performance-test profiles" >&2
    return 1
  fi

  printf '%s' "${EPR_AZURE_STUB_BASE_URL%/}"
}

load_test_run_lease_duration() {
  load_test_run_lease_duration_value="${EPR_LOAD_TEST_LEASE_DURATION_SECONDS:-600}"

  case "$load_test_run_lease_duration_value" in
    ''|*[!0-9]*)
      echo "Error: EPR_LOAD_TEST_LEASE_DURATION_SECONDS must be a whole number of seconds" >&2
      return 1
      ;;
  esac

  if [ "$load_test_run_lease_duration_value" -lt 60 ] || [ "$load_test_run_lease_duration_value" -gt 86400 ]; then
    echo "Error: EPR_LOAD_TEST_LEASE_DURATION_SECONDS must be between 60 and 86400" >&2
    return 1
  fi

  printf '%s' "$load_test_run_lease_duration_value"
}

load_test_run_lease_id() {
  if [ -n "${EPR_LOAD_TEST_RUN_ID:-}" ]; then
    if ! node --input-type=module -e '
      const runId = process.argv[1]
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) process.exit(1)
    ' "$EPR_LOAD_TEST_RUN_ID"; then
      echo "Error: EPR_LOAD_TEST_RUN_ID must be a UUID" >&2
      return 1
    fi

    printf '%s' "$EPR_LOAD_TEST_RUN_ID"
    return
  fi

  node --input-type=module -e "import { randomUUID } from 'node:crypto'; console.log(randomUUID())"
}

load_test_run_lease_request() {
  load_test_run_lease_method="$1"
  load_test_run_lease_url="$2"
  load_test_run_lease_body="${3:-}"
  LOAD_TEST_RUN_LEASE_STATUS=000
  LOAD_TEST_RUN_LEASE_RESPONSE_FILE=$(mktemp)

  if [ -n "$load_test_run_lease_body" ]; then
    LOAD_TEST_RUN_LEASE_STATUS=$(curl --silent --show-error --connect-timeout 5 --max-time 15 \
      --output "$LOAD_TEST_RUN_LEASE_RESPONSE_FILE" \
      --write-out '%{http_code}' \
      --request "$load_test_run_lease_method" \
      --header 'Content-Type: application/json' \
      --data "$load_test_run_lease_body" \
      "$load_test_run_lease_url")
  else
    LOAD_TEST_RUN_LEASE_STATUS=$(curl --silent --show-error --connect-timeout 5 --max-time 15 \
      --output "$LOAD_TEST_RUN_LEASE_RESPONSE_FILE" \
      --write-out '%{http_code}' \
      --request "$load_test_run_lease_method" \
      "$load_test_run_lease_url")
  fi
  load_test_run_lease_curl_status=$?

  if [ "$load_test_run_lease_curl_status" -ne 0 ]; then
    echo "Error: unable to contact the load-test stub at $load_test_run_lease_url" >&2
    rm -f "$LOAD_TEST_RUN_LEASE_RESPONSE_FILE"
    return 1
  fi

  return 0
}

acquire_load_test_run_lease() {
  LOAD_TEST_RUN_LEASE_BASE_URL=$(load_test_run_lease_base_url) || return 1
  LOAD_TEST_RUN_LEASE_DURATION_SECONDS=$(load_test_run_lease_duration) || return 1
  EPR_LOAD_TEST_RUN_ID=$(load_test_run_lease_id) || return 1
  export EPR_LOAD_TEST_RUN_ID

  load_test_run_lease_request \
    POST \
    "$LOAD_TEST_RUN_LEASE_BASE_URL/admin/load-test-runs" \
    "{\"runId\":\"$EPR_LOAD_TEST_RUN_ID\",\"profile\":\"$PROFILE\",\"leaseDurationSeconds\":$LOAD_TEST_RUN_LEASE_DURATION_SECONDS}" \
    || return 1

  case "$LOAD_TEST_RUN_LEASE_STATUS" in
    200|201)
      rm -f "$LOAD_TEST_RUN_LEASE_RESPONSE_FILE"
      ;;
    *)
      echo "Error: unable to acquire the load-test run lease (HTTP $LOAD_TEST_RUN_LEASE_STATUS)." >&2
      cat "$LOAD_TEST_RUN_LEASE_RESPONSE_FILE" >&2
      rm -f "$LOAD_TEST_RUN_LEASE_RESPONSE_FILE"
      return 1
      ;;
  esac

  LOAD_TEST_RUN_LEASE_HEARTBEAT_SECONDS=$((LOAD_TEST_RUN_LEASE_DURATION_SECONDS / 3))
  if [ "$LOAD_TEST_RUN_LEASE_HEARTBEAT_SECONDS" -gt 60 ]; then
    LOAD_TEST_RUN_LEASE_HEARTBEAT_SECONDS=60
  fi
  LOAD_TEST_RUN_LEASE_FAILURE_FILE=$(mktemp)
  rm -f "$LOAD_TEST_RUN_LEASE_FAILURE_FILE"
  export LOAD_TEST_RUN_LEASE_FAILURE_FILE

  echo "Acquired load-test run lease $EPR_LOAD_TEST_RUN_ID for profile $PROFILE."
  load_test_run_lease_heartbeat &
  LOAD_TEST_RUN_LEASE_HEARTBEAT_PID=$!
  export LOAD_TEST_RUN_LEASE_HEARTBEAT_PID
}

load_test_run_lease_heartbeat() {
  while sleep "$LOAD_TEST_RUN_LEASE_HEARTBEAT_SECONDS"; do
    load_test_run_lease_request \
      PUT \
      "$LOAD_TEST_RUN_LEASE_BASE_URL/admin/load-test-runs/$EPR_LOAD_TEST_RUN_ID" \
      "{\"leaseDurationSeconds\":$LOAD_TEST_RUN_LEASE_DURATION_SECONDS}" \
      || true

    if [ "${LOAD_TEST_RUN_LEASE_STATUS:-000}" != "204" ]; then
      echo "Error: lost the load-test run lease for $EPR_LOAD_TEST_RUN_ID." >&2
      [ -f "${LOAD_TEST_RUN_LEASE_RESPONSE_FILE:-}" ] && cat "$LOAD_TEST_RUN_LEASE_RESPONSE_FILE" >&2
      rm -f "${LOAD_TEST_RUN_LEASE_RESPONSE_FILE:-}"
      : >"$LOAD_TEST_RUN_LEASE_FAILURE_FILE"
      return
    fi

    rm -f "$LOAD_TEST_RUN_LEASE_RESPONSE_FILE"
  done
}

ensure_load_test_run_lease() {
  if [ -n "${LOAD_TEST_RUN_LEASE_FAILURE_FILE:-}" ] && [ -f "$LOAD_TEST_RUN_LEASE_FAILURE_FILE" ]; then
    echo "Error: the load-test run lease was lost; this run is not valid." >&2
    return 1
  fi
}

release_load_test_run_lease() {
  if [ -n "${LOAD_TEST_RUN_LEASE_HEARTBEAT_PID:-}" ]; then
    kill "$LOAD_TEST_RUN_LEASE_HEARTBEAT_PID" 2>/dev/null || true
    wait "$LOAD_TEST_RUN_LEASE_HEARTBEAT_PID" 2>/dev/null || true
  fi

  if [ -z "${LOAD_TEST_RUN_LEASE_BASE_URL:-}" ] || [ -z "${EPR_LOAD_TEST_RUN_ID:-}" ]; then
    return 0
  fi

  load_test_run_lease_request \
    DELETE \
    "$LOAD_TEST_RUN_LEASE_BASE_URL/admin/load-test-runs/$EPR_LOAD_TEST_RUN_ID" \
    || return 0

  if [ "$LOAD_TEST_RUN_LEASE_STATUS" != "204" ]; then
    echo "Warning: could not release load-test run lease $EPR_LOAD_TEST_RUN_ID (HTTP $LOAD_TEST_RUN_LEASE_STATUS). It will expire automatically." >&2
    [ -f "$LOAD_TEST_RUN_LEASE_RESPONSE_FILE" ] && cat "$LOAD_TEST_RUN_LEASE_RESPONSE_FILE" >&2
  else
    echo "Released load-test run lease $EPR_LOAD_TEST_RUN_ID."
  fi

  rm -f "$LOAD_TEST_RUN_LEASE_RESPONSE_FILE" "${LOAD_TEST_RUN_LEASE_FAILURE_FILE:-}"
  return 0
}
