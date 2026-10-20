import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export async function summarisePrnRun(catalogue, samplesPath) {
  const organisations = Object.fromEntries(catalogue.organisationIds.map(id => [id, { requests: 0, successes: 0, failures: 0 }]));
  const statuses = {};
  const minutes = new Map();
  const lines = createInterface({ input: createReadStream(samplesPath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const sample = JSON.parse(line);
    if (sample.type !== 'Point') continue;
    if (!['prn_obligation_duration', 'prn_organisation_requests'].includes(sample.metric)) continue;
    const minute = new Date(Math.floor(Date.parse(sample.data.time) / 60000) * 60000).toISOString();
    if (!minutes.has(minute)) minutes.set(minute, { requests: 0, failures: 0, durations: [] });
    const bucket = minutes.get(minute);
    if (sample.metric === 'prn_obligation_duration') {
      bucket.durations.push(sample.data.value);
      continue;
    }
    const { organisation_id: id, outcome, status } = sample.data.tags;
    if (!organisations[id]) throw new Error('PRN samples contain an organisation outside the prepared catalogue');
    organisations[id].requests += sample.data.value;
    organisations[id][outcome === 'success' ? 'successes' : 'failures'] += sample.data.value;
    statuses[status] = (statuses[status] || 0) + sample.data.value;
    bucket.requests += sample.data.value;
    if (outcome !== 'success') bucket.failures += sample.data.value;
  }
  const rows = Object.values(organisations);
  return {
    year: catalogue.year, refreshWindowSeconds: catalogue.refreshWindowSeconds,
    duration: catalogue.duration, targetRatePerMinute: catalogue.ratePerMinute,
    expectedOrganisations: rows.length,
    attemptedOrganisations: rows.filter(row => row.requests > 0).length,
    successfulOrganisations: rows.filter(row => row.successes > 0).length,
    totalRequests: rows.reduce((sum, row) => sum + row.requests, 0),
    httpStatuses: statuses,
    fullCatalogueExpected: catalogue.durationSeconds >= catalogue.refreshWindowSeconds,
    requestsPerOrganisation: organisations,
    minutes: [...minutes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([minute, bucket]) => {
      const sorted = bucket.durations.sort((a, b) => a - b);
      const percentile = fraction => sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
      return { minute, requests: bucket.requests, failures: bucket.failures,
        p50Milliseconds: percentile(0.5), p95Milliseconds: percentile(0.95), p99Milliseconds: percentile(0.99) };
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const catalogue = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const report = await summarisePrnRun(catalogue, process.argv[3]);
    await writeFile(process.argv[4], JSON.stringify(report, null, 2));
    console.log(`PRN coverage: ${report.successfulOrganisations}/${report.expectedOrganisations} organisations successful; ${report.totalRequests} requests`);
    if (report.totalRequests === 0 || (report.fullCatalogueExpected && report.successfulOrganisations !== report.expectedOrganisations)) {
      throw new Error('PRN run did not achieve the required catalogue coverage');
    }
  } catch (error) {
    console.error(`PRN report failed: ${error.message}`);
    process.exitCode = 1;
  }
}
