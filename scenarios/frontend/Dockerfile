# Playwright base image ships Chromium + system fonts. Version pinned to the
# same release the journey-tests repo uses.
FROM mcr.microsoft.com/playwright:v1.59.1-noble

# AWS CLI v2 — used by entrypoint.sh to publish results to S3 in CI mode.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl unzip ca-certificates \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/aws /tmp/awscliv2.zip /var/lib/apt/lists/*

WORKDIR /opt/perftest-lighthouse

COPY package.json ./
RUN npm install --omit=dev

COPY lib/ ./lib/
COPY tests/ ./tests/
COPY entrypoint.sh ./

RUN chmod +x ./entrypoint.sh

ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com
ENV ENVIRONMENT=perf-test
ENV CI=true

ENTRYPOINT ["./entrypoint.sh"]
