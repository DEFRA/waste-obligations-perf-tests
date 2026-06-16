import fs from 'node:fs/promises'
import path from 'node:path'

// Walk resultsDir, read every report.json, and emit an index.html that
// summarises the run. Styling intentionally matches the K6 aggregator in
// scenarios/backend/entrypoint.sh so the two reports feel like one product.

const SCORE_COLOR = (score) => {
  if (score == null) return '#666'
  if (score >= 0.9) return '#0a7d32'
  if (score >= 0.5) return '#b25e00'
  return '#c52525'
}

const fmtMs = (v) =>
  v == null ? '—' : `${(Math.round(v * 10) / 10).toFixed(1)} ms`
const fmtScore = (v) => (v == null ? '—' : (v * 100).toFixed(0))
const fmtCls = (v) => (v == null ? '—' : v.toFixed(3))

function row(name, lhr) {
  const score = lhr?.categories?.performance?.score ?? null
  const audits = lhr?.audits ?? {}
  const cells = [
    `<td><a href="${name}/report.html">${name}</a></td>`,
    `<td class="score" style="color:${SCORE_COLOR(score)}">${fmtScore(score)}</td>`,
    `<td class="num">${fmtMs(audits['first-contentful-paint']?.numericValue)}</td>`,
    `<td class="num">${fmtMs(audits['largest-contentful-paint']?.numericValue)}</td>`,
    `<td class="num">${fmtMs(audits['speed-index']?.numericValue)}</td>`,
    `<td class="num">${fmtMs(audits['total-blocking-time']?.numericValue)}</td>`,
    `<td class="num">${fmtCls(audits['cumulative-layout-shift']?.numericValue)}</td>`,
  ]
  return `<tr>${cells.join('')}</tr>`
}

export async function writeIndex(resultsDir) {
  const entries = await fs.readdir(resultsDir, { withFileTypes: true })
  const rows = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const reportPath = path.join(resultsDir, entry.name, 'report.json')
    let lhr = null
    try {
      lhr = JSON.parse(await fs.readFile(reportPath, 'utf8'))
    } catch {
      // Missing report.json — render the row without metrics so the failure
      // is visible rather than swallowed.
    }
    rows.push(row(entry.name, lhr))
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const env = process.env.ENVIRONMENT ?? '(unset)'

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Lighthouse results — waste-obligations</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { margin: 0 0 .25rem; }
  .meta { color: #666; font-size: .9rem; margin-bottom: 1.5rem; }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; }
  th, td { padding: .55rem .7rem; text-align: left; border-bottom: 1px solid #eee; }
  th { background: #fafafa; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.score { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
  a { color: #0366d6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .footer { color: #666; font-size: .85rem; margin-top: 1.5rem; }
</style>
</head>
<body>
<h1>Lighthouse results</h1>
<p class="meta">Run at ${now} · ENVIRONMENT=${env} · desktop · performance only</p>
<table>
  <thead>
    <tr>
      <th>Step</th>
      <th class="num">Score</th>
      <th class="num">FCP</th>
      <th class="num">LCP</th>
      <th class="num">SI</th>
      <th class="num">TBT</th>
      <th class="num">CLS</th>
    </tr>
  </thead>
  <tbody>
${rows.join('\n')}
  </tbody>
</table>
<p class="footer">Click a step name for its full Lighthouse HTML report.</p>
</body>
</html>
`
  await fs.writeFile(path.join(resultsDir, 'index.html'), html, 'utf8')
}
