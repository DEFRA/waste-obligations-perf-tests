import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createPrnCatalogue, prnConfiguration, readToken, serviceAuth, tokenForm } from './prn-obligations.mjs';

export async function preparePrnCatalogue(env, outputPath) {
  const configuration = prnConfiguration(env);
  // Validate both services before making any request. Secrets never enter the catalogue.
  serviceAuth(env, 'PRN_API', ['oauth2', 'none'], 'body');
  const auth = serviceAuth(env, 'WASTE_ORGANISATIONS', ['oauth2', 'basic'], 'basic');
  const headers = { Accept: 'application/json' };
  const timeout = configuration.requestTimeoutSeconds * 1000;
  if (auth.mode === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64')}`;
  } else {
    const tokenHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (auth.method === 'basic') {
      tokenHeaders.Authorization = `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64')}`;
    }
    const response = await fetch(auth.tokenUrl, {
      method: 'POST', headers: tokenHeaders, body: tokenForm(auth), signal: AbortSignal.timeout(timeout), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Waste Organisations OAuth returned HTTP ${response.status}`);
    headers.Authorization = `Bearer ${readToken(await response.json()).accessToken}`;
  }
  const response = await fetch(`${configuration.organisationsBaseUrl}/organisations`, {
    headers, signal: AbortSignal.timeout(timeout), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Waste Organisations catalogue returned HTTP ${response.status}`);
  const catalogue = createPrnCatalogue(configuration, await response.json());
  await writeFile(outputPath, JSON.stringify(catalogue, null, 2), { mode: 0o600 });
  return catalogue;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error('Pass an output catalogue path');
    const catalogue = await preparePrnCatalogue(process.env, process.argv[2]);
    console.log(`PRN catalogue: ${catalogue.organisationIds.length} organisations for ${catalogue.year}; `
      + `${catalogue.ratePerMinute} requests/minute; refresh window ${catalogue.refreshWindowSeconds}s; duration ${catalogue.duration}`);
  } catch (error) {
    // Do not print response bodies, request headers or OAuth credentials.
    console.error(`PRN preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
