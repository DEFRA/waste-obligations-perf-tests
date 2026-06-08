import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { jUnit } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

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
