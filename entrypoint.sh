#!/bin/sh

# This repo currently runs K6 scenarios only.
# JMeter `.jmx` files under scenarios/ are kept for reference but not executed.
# All run logic lives in scenarios-k6/entrypoint.sh; this script just delegates.

REPO_LOCATION=$(cd "$(dirname "$0")" && pwd)
K6_ENTRYPOINT="${REPO_LOCATION}/scenarios-k6/entrypoint.sh"

if [ ! -x "$K6_ENTRYPOINT" ]; then
  echo "Error: K6 entrypoint not found or not executable at $K6_ENTRYPOINT"
  exit 1
fi

exec "$K6_ENTRYPOINT"
