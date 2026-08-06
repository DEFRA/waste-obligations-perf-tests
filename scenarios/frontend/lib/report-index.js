import fs from 'node:fs/promises'
import path from 'node:path'

// Walk resultsDir, read every report.json, and emit an index.html that
// summarises the run. Styling intentionally matches the K6 aggregator in
// scenarios/backend/entrypoint.sh so the two reports feel like one product.

const escHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

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

function row(profile, name, lhr) {
  const score = lhr?.categories?.performance?.score ?? null
  const audits = lhr?.audits ?? {}
  const cells = [
    `<td><a href="${profile}/${name}/report.html">${name}</a></td>`,
    `<td class="score" style="color:${SCORE_COLOR(score)}">${fmtScore(score)}</td>`,
    `<td class="num">${fmtMs(audits['first-contentful-paint']?.numericValue)}</td>`,
    `<td class="num">${fmtMs(audits['largest-contentful-paint']?.numericValue)}</td>`,
    `<td class="num">${fmtMs(audits['speed-index']?.numericValue)}</td>`,
    `<td class="num">${fmtMs(audits['total-blocking-time']?.numericValue)}</td>`,
    `<td class="num">${fmtCls(audits['cumulative-layout-shift']?.numericValue)}</td>`,
  ]
  return `<tr>${cells.join('')}</tr>`
}

async function profileTable(resultsDir, profile) {
  const profileDir = path.join(resultsDir, profile)
  let stepEntries
  try {
    stepEntries = await fs.readdir(profileDir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  const rows = []
  for (const step of stepEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!step.isDirectory()) continue
    const reportPath = path.join(profileDir, step.name, 'report.json')
    let lhr = null
    try {
      lhr = JSON.parse(await fs.readFile(reportPath, 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[report-index] Failed to read/parse ${reportPath}: ${err.message}`)
      }
    }
    rows.push(row(profile, step.name, lhr))
  }
  if (rows.length === 0) return null

  return `<h2>${profile}</h2>
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
</table>`
}

export async function writeIndex(resultsDir) {
  const entries = await fs.readdir(resultsDir, { withFileTypes: true })
  const profiles = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  const tables = []
  for (const profile of profiles) {
    const table = await profileTable(resultsDir, profile)
    if (table) tables.push(table)
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const env = process.env.ENVIRONMENT ?? '(unset)'
  const profileLabel = profiles.length > 0 ? profiles.join(' + ') : '(no results)'

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Lighthouse results — waste-obligations</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { margin: 0 0 .25rem; }
  h2 { margin: 2rem 0 .5rem; font-size: 1.1rem; text-transform: capitalize; }
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
<p class="meta">Run at ${now} · ENVIRONMENT=${env} · ${profileLabel} · performance only</p>
${tables.join('\n')}
<p class="footer">Click a step name for its full Lighthouse HTML report.</p>
</body>
</html>
`
  await fs.writeFile(path.join(resultsDir, 'index.html'), html, 'utf8')
}

// Injects a load test results section into the Lighthouse index.html that
// csoc-flow.js already wrote to parentResultsDir. loadTestResultsDir is the
// subdir where the raw JSON was written (for the relative link).
export async function writeLoadTestIndex(parentResultsDir, loadTestResultsDir, {
  runAt,
  concurrency,
  iterationsPerUser,
  orgId,
  users
}) {
  const pct = (arr, p) => {
    if (!arr.length) return null
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.ceil((p / 100) * s.length) - 1]
  }
  const fmtMs = (v) => (v == null ? '—' : `${v} ms`)

  const byStep = {}
  for (const { step, elapsed, passed, ttfb, dcl } of users.flatMap((u) => u.timings)) {
    if (!byStep[step]) byStep[step] = { pass: [], fail: 0, ttfbs: [], dcls: [] }
    if (passed) {
      byStep[step].pass.push(elapsed)
      if (ttfb != null) byStep[step].ttfbs.push(ttfb)
      if (dcl != null) byStep[step].dcls.push(dcl)
    } else {
      byStep[step].fail++
    }
  }

  const stepRows = Object.entries(byStep)
    .map(([step, { pass, fail, ttfbs, dcls }]) => {
      pass.sort((a, b) => a - b)
      const allFail = pass.length === 0 && fail > 0
      return `    <tr${allFail ? ' style="color:#c52525"' : ''}>
      <td>${escHtml(step)}</td>
      <td class="num" style="color:#0a7d32">${pass.length}</td>
      <td class="num"${fail > 0 ? ' style="color:#c52525"' : ''}>${fail}</td>
      <td class="num">${fmtMs(pass[0] ?? null)}</td>
      <td class="num">${fmtMs(pct(pass, 50))}</td>
      <td class="num">${fmtMs(pct(pass, 95))}</td>
      <td class="num">${fmtMs(pass[pass.length - 1] ?? null)}</td>
      <td class="num">${fmtMs(pct(ttfbs, 50))}</td>
      <td class="num">${fmtMs(pct(dcls, 50))}</td>
    </tr>`
    })
    .join('\n')

  const fatalUsers = users.filter((u) => u.fatalError)
  const fatalSection =
    fatalUsers.length === 0
      ? ''
      : `<h2>Fatal Errors (${fatalUsers.length})</h2>
<table>
  <thead><tr><th>User</th><th>Error</th></tr></thead>
  <tbody>
${fatalUsers.map((u) => `    <tr><td>${u.userIndex}</td><td>${escHtml(u.fatalError)}</td></tr>`).join('\n')}
  </tbody>
</table>`

  const loadTestFiles = await fs.readdir(loadTestResultsDir)
  const jsonFile = loadTestFiles.find((f) => f.startsWith('load-test-') && f.endsWith('.json'))
  if (!jsonFile) {
    console.error('[report-index] writeLoadTestIndex: no load-test-*.json found — raw JSON link will be omitted')
  }
  const loadTestSubdir = path.basename(loadTestResultsDir)
  const jsonLink = jsonFile ? ` · <a href="${escHtml(loadTestSubdir)}/${escHtml(jsonFile)}">raw JSON</a>` : ''

  const now = new Date(runAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const env = process.env.ENVIRONMENT ?? '(unset)'

  const section = `
<hr style="margin: 2rem 0; border: none; border-top: 1px solid #eee;">
<h1>Load Test Results</h1>
<p class="meta">Run at ${now} · ENVIRONMENT=${env} · ${concurrency} parallel users · ${iterationsPerUser} iteration${iterationsPerUser === 1 ? '' : 's'} per user · org ${escHtml(orgId)}${jsonLink}</p>
<h2>Step Summary</h2>
<table>
  <thead>
    <tr>
      <th>Step</th>
      <th class="num">Pass</th>
      <th class="num">Fail</th>
      <th class="num">Min</th>
      <th class="num">P50</th>
      <th class="num">P95</th>
      <th class="num">Max</th>
      <th class="num">P50 TTFB</th>
      <th class="num">P50 DCL</th>
    </tr>
  </thead>
  <tbody>
${stepRows}
  </tbody>
</table>
${fatalSection}
<p class="footer">Times are wall-clock ms from step start to heading visible. TTFB and DCL are browser Navigation Timing values (goto-based steps only).</p>`

  const indexPath = path.join(parentResultsDir, 'index.html')

  // Fall back to a standalone page if Lighthouse didn't produce an index.html
  // (e.g. it was skipped or failed before writeIndex ran).
  let existing
  try {
    existing = await fs.readFile(indexPath, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    console.error('[report-index] writeLoadTestIndex: index.html not found — writing standalone load test report')
    existing = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Load Test Results — waste-obligations</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}h1{margin:0 0 .25rem}h2{margin:2rem 0 .5rem;font-size:1.1rem}.meta{color:#666;font-size:.9rem;margin-bottom:1.5rem}table{border-collapse:collapse;width:100%;font-size:.92rem}th,td{padding:.55rem .7rem;text-align:left;border-bottom:1px solid #eee}th{background:#fafafa;font-weight:600}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}a{color:#0366d6;text-decoration:none}a:hover{text-decoration:underline}.footer{color:#666;font-size:.85rem;margin-top:1.5rem}</style></head><body></body></html>`
  }

  const marker = '</body>'
  const insertAt = existing.lastIndexOf(marker)
  if (insertAt === -1) {
    throw new Error(
      `writeLoadTestIndex: "${marker}" not found in ${indexPath} — load test section cannot be injected`
    )
  }
  await fs.writeFile(
    indexPath,
    existing.slice(0, insertAt) + section + '\n' + existing.slice(insertAt),
    'utf8'
  )
}
