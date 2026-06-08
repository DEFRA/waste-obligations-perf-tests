FROM grafana/k6:latest AS k6bin

FROM defradigital/cdp-perf-test-docker:latest

USER root
COPY --from=k6bin /usr/bin/k6 /usr/local/bin/k6

# jq is required by scenarios-k6/entrypoint.sh to build the aggregated
# index.html. Install it for whichever package manager the base image ships.
RUN command -v jq >/dev/null 2>&1 || \
    (command -v apk >/dev/null 2>&1 && apk add --no-cache jq) || \
    (command -v apt-get >/dev/null 2>&1 && apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*)

WORKDIR /opt/perftest

COPY scenarios-k6/ ./scenarios-k6/
COPY entrypoint.sh .

RUN chmod +x ./entrypoint.sh ./scenarios-k6/entrypoint.sh

ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com
ENV TEST_SCENARIO=all
ENV CI=true

ENTRYPOINT [ "./entrypoint.sh" ]
