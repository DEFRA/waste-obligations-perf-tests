// K6 scenario option objects matching the CSoC review load model.
// Rates use timeUnit: '1m' so the numbers here match the review verbatim.

export const SCENARIO_A = {
  executor: 'constant-arrival-rate',
  rate: 10,
  timeUnit: '1m',
  duration: '5m',
  preAllocatedVUs: 5,
  maxVUs: 20,
};

export const SCENARIO_B = {
  executor: 'constant-arrival-rate',
  rate: 40,
  timeUnit: '1m',
  duration: '15m',
  preAllocatedVUs: 5,
  maxVUs: 20,
};

export const SPIKE = {
  executor: 'ramping-arrival-rate',
  startRate: 0,
  timeUnit: '1m',
  preAllocatedVUs: 20,
  maxVUs: 60,
  stages: [
    { target: 240, duration: '5s' },
    { target: 240, duration: '10s' },
    { target: 0, duration: '5s' },
    { target: 0, duration: '1m' },
  ],
};

export const CAPACITY = {
  executor: 'ramping-arrival-rate',
  startRate: 20,
  timeUnit: '1m',
  preAllocatedVUs: 10,
  maxVUs: 40,
  stages: [
    { target: 20, duration: '2m' },
    { target: 40, duration: '2m' },
    { target: 60, duration: '2m' },
    { target: 80, duration: '2m' },
    { target: 100, duration: '2m' },
    { target: 120, duration: '2m' },
  ],
};

// Overrides for the create-compliance-declaration write path — each iteration
// runs POST + PATCH + GET, so needs more headroom than the read endpoints.
export const WRITE_VU_OVERRIDES = {
  scenarioA: { preAllocatedVUs: 5, maxVUs: 20 },
  scenarioB: { preAllocatedVUs: 10, maxVUs: 40 },
  spike: { preAllocatedVUs: 20, maxVUs: 60 },
  capacity: { preAllocatedVUs: 20, maxVUs: 60 },
};

// Derive the http_reqs floor from the configured rate so the threshold cannot
// go stale like the rate>=19 one on get-compliance-declarations/load.js.
function reqsPerSecFloor(ratePerMin) {
  return ((ratePerMin / 60) * 0.95).toFixed(3);
}

export function constantThresholds(ratePerMin, p95Ms = 2000) {
  return {
    http_req_duration: [`p(95)<${p95Ms}`],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    http_reqs: [`rate>=${reqsPerSecFloor(ratePerMin)}`],
    iteration_duration: ['p(95)<3000'],
    dropped_iterations: ['count<5'],
  };
}

export function spikeThresholds(p95Ms = 2000) {
  return {
    http_req_duration: [`p(95)<${p95Ms * 2}`],
    http_req_failed: ['rate<0.05'],
    checks: ['rate>0.9'],
  };
}

export const capacityThresholds = {
  checks: ['rate>0.5'],
};
