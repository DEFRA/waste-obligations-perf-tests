import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPerformancePlan } from './unsubmitted-performance-config.mjs'
import { taskDeadline } from './polling-budget.mjs'

const exists = file => access(file).then(() => true, () => false)
const escape = value => String(value ?? '—').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

export function summaryPassed(summary, exitCode) {
  const thresholds = Object.values(summary?.metrics ?? {}).flatMap(metric => Object.values(metric.thresholds ?? {}))
  return exitCode === 0 && summary?.metrics?.iterations?.values?.count > 0
    && thresholds.length > 0 && thresholds.every(threshold => threshold.ok === true)
}

export async function writeApiIndex(directory, session) {
  // Read the same k6 summary artifacts as the existing backend overview. This
  // also permits rebuilding the presentation without repeating a workload.
  const phases = await Promise.all(session.phases.map(async phase => {
    try {
      const summary = JSON.parse(await readFile(path.join(directory, phase.directory, 'summary.json'), 'utf8'))
      return { ...phase, metrics: summaryMetrics(summary) }
    } catch { return phase }
  }))
  await writeFile(path.join(directory, 'session.json'), JSON.stringify({ ...session, phases }, null, 2))
  const assets = fileURLToPath(new URL('../scenarios/backend/lib/report/', import.meta.url))
  await Promise.all(['report.css', 'report.js', 'chart.umd.min.js'].map(asset => copyFile(path.join(assets, asset), path.join(directory, asset))))
  const number = value => value == null ? '—' : escape(Math.round(value * 100) / 100)
  const milliseconds = value => value == null ? '—' : `${number(value)} ms`
  const percent = value => value == null ? '—' : `${number(value * 100)}%`
  const link = phase => `<a href="${escape(phase.directory)}/summary.html">${escape(phase.directory)}</a>`
  const rows = phases.map(phase => {
    const m = phase.metrics ?? {}
    const status = phase.passed ? 'pass' : phase.finishedAt ? 'fail' : 'incomplete'
    const label = phase.passed ? '✓ pass' : phase.finishedAt ? '✗ fail' : 'incomplete'
    return `<tr class="${status}"><td>${link(phase)}</td><td class="status">${label}</td>
      <td class="num">${number(m.vusMax)}</td><td class="num">${number(m.iterations)}</td><td class="num">${number(m.requests)}</td>
      <td class="num">${milliseconds(m.average)}</td><td class="num">${milliseconds(m.p95)}</td>
      <td class="num">${percent(m.failureRate)}</td><td class="num">${percent(m.checkRate)}</td></tr>`
  }).join('\n')
  const observations = phases.map(phase => `<tr><td>${link(phase)}</td><td>${escape(phase.startedAt)}</td><td>${escape(phase.journeyStartAt)}</td>
    <td class="num">${number(phase.metrics?.laterPageRequests)}</td><td class="num">${number(phase.metrics?.totalMin)}–${number(phase.metrics?.totalMax)}</td></tr>`).join('\n')
  const data = phases.map(phase => ({ name: phase.directory, pass: !!phase.passed,
    reqs: phase.metrics?.requests, reqRate: phase.metrics?.requestRate, avg: phase.metrics?.average,
    p95: phase.metrics?.p95, failRate: phase.metrics?.failureRate, checkRate: phase.metrics?.checkRate }))
  await writeFile(path.join(directory, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <title>Unsubmitted API performance</title><link rel="stylesheet" href="report.css"></head><body>
    <h1>Unsubmitted API performance</h1>
    <p class="meta">Run at ${escape(session.startedAt)} · Session: ${session.finishedAt ? session.passed ? 'PASS' : 'FAIL' : 'INCOMPLETE'} · ${session.smoke ? 'SMOKE — shortened windows; does not establish the release SLA.' : 'Release SLA windows: A at 10 req/min for 3 minutes; B at 40 req/min for 5 minutes.'}</p>
    <p class="meta"><a href="../index.html">All performance results</a> · <a href="../run-configuration.json">Effective service and runner configuration</a> · <a href="session.json">Phase timings and outcomes (JSON)</a></p>
    <div id="counters" class="counters"></div>
    <h2>Scenarios</h2><div class="panel" style="padding:0;overflow-x:auto"><table><thead><tr>
      <th>Scenario</th><th>Status</th><th class="num">VUs max</th><th class="num">Iters</th><th class="num">Reqs</th>
      <th class="num">Avg</th><th class="num">p(95)</th><th class="num">Fail %</th><th class="num">Checks %</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <h2>Charts</h2><div class="charts-grid">
      <div class="panel chart-card"><h3>Response time — avg &amp; p(95)</h3><div class="chart-wrap"><canvas id="ch-latency"></canvas></div></div>
      <div class="panel chart-card"><h3>Throughput (req/s)</h3><div class="chart-wrap"><canvas id="ch-throughput"></canvas></div></div>
      <div class="panel chart-card"><h3>Failure rate (%)</h3><div class="chart-wrap"><canvas id="ch-fail"></canvas></div></div>
      <div class="panel chart-card"><h3>Check pass rate (%)</h3><div class="chart-wrap"><canvas id="ch-check"></canvas></div></div>
    </div>
    <h2>Workload observations</h2><div class="panel" style="padding:0;overflow-x:auto"><table><thead><tr>
      <th>Scenario</th><th>Started (UTC)</th><th>Shared journey start (UTC)</th><th class="num">Requests to page &gt; 1</th><th class="num">Observed total min–max</th>
    </tr></thead><tbody>${observations}</tbody></table></div>
    <h2>Session details</h2><div class="panel">
    <p>Baseline: all checks pass. A/B: p95 &lt; 2000 ms; failures &lt; 1%; checks &gt; 99%; no dropped arrivals; expected request count delivered.</p>
    <p>Rates apply to dedicated API requests. Existing polling, readiness, discovery and browser verification add endpoint traffic.</p>
    <p>${escape(session.stopReason ?? 'Session running')}</p></div>
    <p class="footer">Click a scenario name for its full k6 HTML report. Per-scenario summary JSON, JUnit XML and k6 logs are alongside.</p>
    <script>window.K6_DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>
    <script src="chart.umd.min.js"></script><script src="report.js"></script></body></html>`)
}

function summaryMetrics(summary) {
  const metrics = summary?.metrics ?? {}
  return {
    requests: metrics.http_reqs?.values?.count, requestRate: metrics.http_reqs?.values?.rate,
    iterations: metrics.iterations?.values?.count, vusMax: metrics.vus_max?.values?.max ?? metrics.vus_max?.values?.value,
    average: metrics.http_req_duration?.values?.avg, p95: metrics.http_req_duration?.values?.['p(95)'],
    laterPageRequests: metrics.unsubmitted_later_page_requests?.values?.count,
    totalMin: metrics.unsubmitted_observed_total?.values?.min, totalMax: metrics.unsubmitted_observed_total?.values?.max,
    failureRate: metrics.http_req_failed?.values?.rate, checkRate: metrics.checks?.values?.rate
  }
}

async function executeK6(script, directory, env, cwd) {
  const log = createWriteStream(path.join(directory, 'k6.log'))
  const child = spawn('k6', ['run', script], { cwd, env: { ...env, RESULTS_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log.write(chunk); process.stdout.write(chunk) })
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve(signal ? 1 : code))
    })
  } finally { await new Promise(resolve => log.end(resolve)) }
}

export async function runApiSession(env = process.env, execute = executeK6) {
  const plan = apiPerformancePlan(env)
  const directory = env.LOAD_TEST_API_RESULTS_DIR
  const stopFile = env.LOAD_TEST_API_STOP_FILE
  if (!directory || !stopFile || !env.LOAD_TEST_API_CATALOGUE_PATH) throw new Error('API session requires results directory, stop file and initialised catalogue')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const cwd = path.join(root, 'scenarios/backend')
  await mkdir(directory, { recursive: true })
  const session = { smoke: plan.smoke, startedAt: new Date().toISOString(), phases: [] }
  let failed = false
  const phase = async (name, relativeDirectory) => {
    const resultDirectory = path.join(directory, relativeDirectory)
    await mkdir(resultDirectory, { recursive: true })
    const record = { name, directory: relativeDirectory, startedAt: new Date().toISOString() }
    session.phases.push(record)
    await writeApiIndex(directory, session)
    console.log(`Unsubmitted API phase ${relativeDirectory} starting at ${record.startedAt}`)
    let code = 1
    try { code = await execute(`tests/get-unsubmitted-organisations/${name}.js`, resultDirectory, env, cwd) }
    catch { record.error = 'Unable to execute k6; inspect the phase log and runner dependencies' }
    let summary
    try { summary = JSON.parse(await readFile(path.join(resultDirectory, 'summary.json'), 'utf8')) }
    catch { record.error = 'Missing or unreadable k6 summary' }
    record.exitCode = code
    record.passed = summaryPassed(summary, code)
    record.finishedAt = new Date().toISOString()
    if (env.LOAD_TEST_START_FILE && await exists(env.LOAD_TEST_START_FILE)) {
      const start = Number(await readFile(env.LOAD_TEST_START_FILE, 'utf8'))
      if (Number.isFinite(start)) record.journeyStartAt = new Date(start).toISOString()
    }
    record.metrics = summaryMetrics(summary)
    failed ||= !record.passed
    await writeApiIndex(directory, session)
    return record.passed
  }
  if (!await phase('baseline', 'baseline')) session.stopReason = 'Baseline failed; API load phases skipped'
  else {
    let round = 1
    // Allow each k6 process a minute beyond its 30s graceful stop for startup,
    // summary generation and report writes before the task watchdog boundary.
    const roundMilliseconds = plan.phases.reduce((sum, item) => sum + item.milliseconds + 90000, 0)
    while (!await exists(stopFile)) {
      if (Date.now() + roundMilliseconds + 300000 > taskDeadline(env)) {
        failed = true
        session.stopReason = 'No further complete A/B round fits before the cleanup/report reserve while existing workloads are still active; API coverage is incomplete'
        break
      }
      for (const item of plan.phases) await phase(item.name, `round-${String(round).padStart(3, '0')}/${item.name}`)
      round++
    }
    session.stopReason ??= 'Existing polling/journey workloads finished; final A/B round completed'
  }
  if (!session.phases.some(item => item.name === 'scenario-b-stress')) {
    failed = true
    session.stopReason += '; no complete A/B round ran'
  }
  session.finishedAt = new Date().toISOString()
  session.passed = !failed
  await writeApiIndex(directory, session)
  return failed ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runApiSession()
