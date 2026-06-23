FROM grafana/k6:latest AS k6bin

# Playwright base — ships Node, Chromium, system fonts. Same pinned version
# as the standalone Lighthouse image.
FROM mcr.microsoft.com/playwright:v1.59.1-noble

USER root

# K6 binary copied from the official image.
COPY --from=k6bin /usr/bin/k6 /usr/local/bin/k6

# jq powers the K6 aggregated index; AWS CLI v2 powers the S3 upload from the
# root entrypoint.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl unzip ca-certificates jq \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/aws /tmp/awscliv2.zip /var/lib/apt/lists/*

WORKDIR /opt/perftest

# Lighthouse only drives Chromium — strip the bundled Firefox + WebKit to
# trim ~500MB off the image. Playwright keeps Chromium under /ms-playwright/
# (the base image pre-sets PLAYWRIGHT_BROWSERS_PATH to that dir).
RUN rm -rf /ms-playwright/firefox* /ms-playwright/webkit*

COPY scenarios/ ./scenarios/
COPY entrypoint.sh .

# Pre-install Lighthouse npm deps at build time so cold-start containers
# don't have to hit the registry. PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD prevents
# the postinstall from re-fetching the browsers we just trimmed.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN cd scenarios/frontend && npm ci --omit=dev

RUN chmod +x ./entrypoint.sh ./scenarios/backend/entrypoint.sh ./scenarios/frontend/entrypoint.sh

ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com
ENV TEST_SCENARIO=all
ENV CI=true

ENTRYPOINT [ "./entrypoint.sh" ]
