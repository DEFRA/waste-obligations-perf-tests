import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { terminateOwnedWorkload } from './owned-workload.mjs'
import { effectivePollingTiming } from './polling-timing.mjs'
import { assertMeasurementFits, remainingReadinessBudget, taskDeadline, watchTaskDeadline } from './polling-budget.mjs'

const timing = { measuredDurationMilliseconds: 3600000, readinessTimeoutMilliseconds: 4127000 }
const env = { LOAD_TEST_RUN_DEADLINE_MS: '7200000' }

test('task budget cannot exceed CDP hard limit and supports a lower deadline', () => {
  assert.equal(taskDeadline({}, 1000), 7201000)
  assert.equal(taskDeadline({ LOAD_TEST_TASK_BUDGET_SECONDS: '3600' }, 1000), 3601000)
  assert.throws(() => taskDeadline({ LOAD_TEST_TASK_BUDGET_SECONDS: '7201' }), /two-hour/)
})

test('readiness is limited by full measurement, auth and cleanup reserve after elapsed setup', () => {
  assert.equal(remainingReadinessBudget(timing, env, 60000), 3240000)
  assert.equal(remainingReadinessBudget(timing, { ...env, PROFILE: 'unsubmitted-journey' }, 60000), 2340000)
  assert.throws(() => remainingReadinessBudget(timing, env, 3400000), /Insufficient/)
})

test('measurement rejects elapsed authentication rather than silently shortening duration', () => {
  assert.doesNotThrow(() => assertMeasurementFits(timing, env, 3000000))
  assert.throws(() => assertMeasurementFits(timing, env, 3400000), /full measured window/)
  assert.equal(timing.measuredDurationMilliseconds, 3600000)
})


test('real deadline signal interrupts a hung workload and completes owned cleanup', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'polling-deadline-'))
  const groupFile = path.join(directory, 'group.json')
  const heartbeat = path.join(directory, 'heartbeat')
  const cleaned = path.join(directory, 'cleaned')
  const workload = fileURLToPath(new URL('./owned-workload.mjs', import.meta.url))
  const budget = fileURLToPath(new URL('./polling-budget.mjs', import.meta.url))
  const script = path.join(directory, 'runner.sh')
  const childScript = path.join(directory, 'child.cjs')
  await writeFile(childScript, `setInterval(()=>require('fs').appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`)
  await writeFile(script, `#!/bin/sh
trap 'kill "$watchdog_pid" "$owned_pid" 2>/dev/null || true; node "${workload}" stop "${groupFile}" deadline-run; wait "$owned_pid" 2>/dev/null || true; printf cleaned > "${cleaned}"; exit 143' TERM
node "${workload}" run "${groupFile}" deadline-run "${directory}" node "${childScript}" &
owned_pid=$!
node "${budget}" watch "${Date.now() + 300800}" "$$" &
watchdog_pid=$!
wait "$owned_pid"
`)
  const runner = spawn('sh', [script], { stdio: 'ignore' })
  const exit = new Promise(resolve => runner.once('close', code => resolve(code)))
  try {
    assert.equal(await exit, 143)
    assert.equal(await readFile(cleaned, 'utf8'), 'cleaned')
    const stopped = await readFile(heartbeat, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await readFile(heartbeat, 'utf8'), stopped)
    await assert.rejects(readFile(groupFile), { code: 'ENOENT' })
  } finally {
    await terminateOwnedWorkload(groupFile, 'deadline-run')
    runner.kill('SIGKILL')
    await exit
    await rm(directory, { recursive: true, force: true })
  }
})

test('watchdog refuses a stale root identity without signalling a benign process', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  const exit = new Promise(resolve => child.once('close', resolve))
  try {
    await watchTaskDeadline(Date.now() + 300020, child.pid, 'previous root identity')
    assert.doesNotThrow(() => process.kill(child.pid, 0))
  } finally {
    child.kill('SIGKILL')
    await exit
  }
})


test('explicit readiness timeout within the clipped combined budget does not require short smoke', () => {
  const runtime = { eligibilityRefreshPollingEnabled: true, organisationPollIntervalSeconds: 300,
    obligationPollingEnabled: true, obligationRefreshIntervalSeconds: 1800, maximumSummaryStalenessSeconds: 3600,
    maxDownstreamRequestsPerMinute: 180, obligationPollIntervalSeconds: 60, currentObligationYear: 2026 }
  const configured = effectivePollingTiming(runtime, 500, { LOAD_TEST_READINESS_TIMEOUT_MS: '1800000' })
  assert.equal(configured.shortSmoke, false)
  assert.equal(configured.measuredDurationMilliseconds, 3600000)
  assert.equal(configured.recommendedReadinessTimeoutMilliseconds, 4127000)
  assert.equal(remainingReadinessBudget(configured, { ...env, PROFILE: 'unsubmitted-journey' }, 0), 1800000)
  const longerTimeout = effectivePollingTiming(runtime, 500, { LOAD_TEST_READINESS_TIMEOUT_MS: '3600000' })
  assert.equal(remainingReadinessBudget(longerTimeout, { ...env, PROFILE: 'unsubmitted-journey' }, 0), 2400000)
})
