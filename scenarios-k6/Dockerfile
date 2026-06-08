FROM grafana/k6:latest AS k6bin

FROM defradigital/cdp-perf-test-docker:latest

USER root
COPY --from=k6bin /usr/bin/k6 /usr/local/bin/k6

WORKDIR /opt/perftest-k6

COPY lib/ ./lib/
COPY scenarios/ ./scenarios/
COPY entrypoint.sh .

RUN chmod +x ./entrypoint.sh

ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com
ENV TEST_SCENARIO=all
ENV CI=true

ENTRYPOINT ["./entrypoint.sh"]
