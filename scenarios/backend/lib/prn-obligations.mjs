// Shared by the catalogue preparation command and k6. Keep this module runtime-independent.
function positiveInteger(env, name, fallback) {
  const value = Number(env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function durationSeconds(value) {
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match || Number(match[1]) < 1) throw new Error('PRN_TEST_DURATION must be a positive duration, e.g. 30m');
  const seconds = Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2]];
  if (!Number.isSafeInteger(seconds)) throw new Error('PRN_TEST_DURATION is too large');
  return seconds;
}

function endpoint(value, name) {
  // URL is unavailable in some k6 versions. Reject credentials, query strings and fragments.
  if (!/^https?:\/\/[^/?#@\s]+(?:\/[^?#\s]*)?$/.test(value || '')) {
    throw new Error(`${name} must be an http(s) URL without credentials, query or fragment`);
  }
  return value.replace(/\/+$/, '');
}

export function serviceAuth(env, prefix, modes, defaultMethod) {
  const mode = env[`${prefix}_AUTH_MODE`] || 'oauth2';
  if (!modes.includes(mode)) throw new Error(`${prefix}_AUTH_MODE must be ${modes.join(' or ')}`);
  if (mode === 'none') return { mode };
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) throw new Error(`${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET are required`);
  if (mode === 'basic') return { mode, clientId, clientSecret };
  const tokenUrl = endpoint(env[`${prefix}_TOKEN_URL`], `${prefix}_TOKEN_URL`);
  const method = env[`${prefix}_TOKEN_AUTH_METHOD`] || defaultMethod;
  if (!['body', 'basic'].includes(method)) throw new Error(`${prefix}_TOKEN_AUTH_METHOD must be body or basic`);
  const scope = env[`${prefix}_SCOPE`] || '';
  if (prefix === 'PRN_API' && !scope) throw new Error('PRN_API_SCOPE is required for OAuth');
  return { mode, clientId, clientSecret, tokenUrl, method, scope };
}

export function tokenForm(auth) {
  const fields = { grant_type: 'client_credentials' };
  if (auth.method === 'body') {
    fields.client_id = auth.clientId;
    fields.client_secret = auth.clientSecret;
  }
  if (auth.scope) fields.scope = auth.scope;
  return Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}

export function readToken(body, now = Date.now()) {
  const lifetime = Number(body?.expires_in);
  if (typeof body?.access_token !== 'string' || !body.access_token || !Number.isFinite(lifetime) || lifetime <= 0) {
    throw new Error('OAuth response must contain access_token and a positive expires_in');
  }
  // The local stub issues 60-second tokens; subtracting a fixed minute would expire those immediately.
  return { accessToken: body.access_token, refreshAt: now + (lifetime - Math.min(60, lifetime * 0.1)) * 1000 };
}

export function prnConfiguration(env, currentYear = new Date().getUTCFullYear()) {
  const year = positiveInteger(env, 'PRN_TEST_OBLIGATION_YEAR', currentYear);
  const refreshWindowSeconds = positiveInteger(env, 'PRN_TEST_REFRESH_WINDOW_SECONDS', 1800);
  const duration = env.PRN_TEST_DURATION || '30m';
  const preAllocatedVUs = positiveInteger(env, 'PRN_TEST_PREALLOCATED_VUS', 5);
  const maxVUs = positiveInteger(env, 'PRN_TEST_MAX_VUS', 50);
  if (maxVUs < preAllocatedVUs) throw new Error('PRN_TEST_MAX_VUS must be at least PRN_TEST_PREALLOCATED_VUS');
  const configuration = {
    year, refreshWindowSeconds, duration, durationSeconds: durationSeconds(duration),
    preAllocatedVUs, maxVUs,
    requestTimeoutSeconds: positiveInteger(env, 'PRN_TEST_REQUEST_TIMEOUT_SECONDS', 60),
    p95Milliseconds: env.PRN_TEST_P95_MS ? positiveInteger(env, 'PRN_TEST_P95_MS') : null,
    organisationsBaseUrl: endpoint(env.WASTE_ORGANISATIONS_BASE_URL, 'WASTE_ORGANISATIONS_BASE_URL'),
    prnBaseUrl: endpoint(env.PRN_API_BASE_URL, 'PRN_API_BASE_URL'),
  };
  return configuration;
}

export function organisationCatalogue(body, year) {
  if (!Array.isArray(body?.organisations)) throw new Error('Organisation response must contain an organisations array');
  const ids = new Set();
  for (const organisation of body.organisations) {
    if (!Array.isArray(organisation.registrations)) throw new Error('Organisation is missing its registrations array');
    const eligible = organisation.registrations.some(registration =>
      registration.registrationYear === year && registration.status === 'REGISTERED'
      && ['LARGE_PRODUCER', 'COMPLIANCE_SCHEME'].includes(registration.type));
    if (!eligible) continue;
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(organisation.id || '')
        || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(organisation.id)) {
      throw new Error('An eligible organisation has a missing or invalid ID');
    }
    ids.add(organisation.id.toLowerCase());
  }
  if (!ids.size) throw new Error(`No eligible organisations found for ${year}`);
  return [...ids].sort();
}

export function createPrnCatalogue(configuration, body) {
  const organisationIds = organisationCatalogue(body, configuration.year);
  return {
    ...configuration, organisationIds,
    ratePerMinute: Math.ceil(organisationIds.length * 60 / configuration.refreshWindowSeconds),
  };
}

export function validObligations(body, organisationId) {
  return Array.isArray(body?.obligationData)
    && Number.isInteger(body.numberOfPrnsAwaitingAcceptance) && body.numberOfPrnsAwaitingAcceptance >= 0
    && body.obligationData.every(row => typeof row.organisationId === 'string'
      && row.organisationId.toLowerCase() === organisationId.toLowerCase()
      && typeof row.materialName === 'string');
}
