FROM grafana/k6:latest AS k6bin

FROM defradigital/cdp-perf-test-docker:latest

USER root
COPY --from=k6bin /usr/bin/k6 /usr/local/bin/k6

WORKDIR /opt/perftest

COPY scenarios-k6/ ./scenarios-k6/
COPY entrypoint.sh .

RUN chmod +x ./entrypoint.sh ./scenarios-k6/entrypoint.sh

ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com
ENV TEST_SCENARIO=all
ENV CI=true

ENTRYPOINT [ "./entrypoint.sh" ]
