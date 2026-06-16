// Vendored to avoid runtime network imports — the CDP proxy blocks/redirects
// `raw.githubusercontent.com` and `jslib.k6.io`, which makes remote `import`s
// flake or fail outright (k6 doesn't follow redirects).
//   k6-reporter.js: https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js
//   k6-summary.js:  https://jslib.k6.io/k6-summary/0.0.2/index.js
import { htmlReport } from './k6-reporter.js';
import { textSummary, jUnit } from './k6-summary.js';

export function buildHandleSummary(outDir = 'results') {
  return function handleSummary(data) {
    return {
      stdout: textSummary(data, { indent: ' ', enableColors: true }),
      [`${outDir}/summary.html`]: htmlReport(data),
      [`${outDir}/summary.json`]: JSON.stringify(data, null, 2),
      [`${outDir}/junit.xml`]: jUnit(data),
    };
  };
}
