import { sleep } from 'k6';

const ORG_IDS = [
  '9d3c4d0f-8e5a-4b91-9f7a-2e8d6a1c5f42',
  'c71b2e84-3f9d-47aa-a8c6-5b4ef0139d8e',
];

export function environment() {
  const env = __ENV.ENVIRONMENT;
  if (!env) {
    throw new Error('ENVIRONMENT env var is required');
  }
  return env;
}

export function baseUrl() {
  return `https://waste-obligations.${environment()}.cdp-int.defra.cloud`;
}

export function headers(extra = {}) {
  const token = __ENV.AUTH_TOKEN;
  if (!token) {
    throw new Error('AUTH_TOKEN env var is required');
  }
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Basic ${token}`,
    ...extra,
  };
}

export function pickOrgId() {
  return ORG_IDS[Math.floor(Math.random() * ORG_IDS.length)];
}

export function thinkTime() {
  sleep(0.5 + Math.random());
}

export const httpParams = {
  timeout: '60s',
};
