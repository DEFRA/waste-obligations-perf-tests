import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export function taskDeadline(env = {}, startedAt = Date.now()) {
  const seconds = Number(env.LOAD_TEST_TASK_BUDGET_SECONDS ?? 7200)
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 7200) throw new Error('LOAD_TEST_TASK_BUDGET_SECONDS must be 1–7200; CDP tasks have a two-hour limit')
  const deadline = Number(env.LOAD_TEST_RUN_DEADLINE_MS ?? startedAt + seconds * 1000)
  if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error('Invalid load-test task deadline')
  return deadline
}

export function remainingReadinessBudget(timing, env = {}, now = Date.now()) {
  const authSeconds = env.PROFILE === 'unsubmitted-journey' ? Number(env.LOAD_TEST_AUTH_TIMEOUT_SECONDS ?? 900) : 0
  if (!Number.isInteger(authSeconds) || authSeconds < 0 || authSeconds > 7200) throw new Error('LOAD_TEST_AUTH_TIMEOUT_SECONDS must be 0–7200')
  const available = taskDeadline(env, now) - now - timing.measuredDurationMilliseconds - 300000 - authSeconds * 1000
  if (available <= 0) throw new Error('Insufficient runner time budget for readiness, authentication, the full measured window and five-minute cleanup/report reserve')
  return Math.min(timing.readinessTimeoutMilliseconds, available)
}

export function assertMeasurementFits(timing, env = {}, now = Date.now()) {
  if (now + 5000 + timing.measuredDurationMilliseconds + 300000 > taskDeadline(env, now)) throw new Error('Insufficient runner time budget for the full measured window and five-minute cleanup/report reserve; reduce setup time or explicitly select a short smoke run')
}

async function processIdentity(pid) {
  try {
    const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'lstart='])
    return stdout.trim() || null
  } catch (error) {
    if (error.code === 1) return null
    throw error
  }
}

export async function watchTaskDeadline(deadline, parentPid, expectedIdentity) {
  if (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(parentPid) || parentPid < 1) throw new Error('Invalid task watchdog identity or deadline')
  const identity = expectedIdentity ?? await processIdentity(parentPid)
  if (!identity) return
  await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - 300000 - Date.now())))
  if (await processIdentity(parentPid) !== identity) return
  console.error('Runner time budget exhausted; stopping owned workloads with five minutes reserved for cleanup')
  try { process.kill(parentPid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'start') console.log(taskDeadline({ ...process.env, LOAD_TEST_RUN_DEADLINE_MS: undefined }, Number(process.argv[3])))
  else if (process.argv[2] === 'check') assertMeasurementFits(JSON.parse(await readFile(process.argv[3], 'utf8')).timing, process.env)
  else if (process.argv[2] === 'watch') await watchTaskDeadline(Number(process.argv[3]), Number(process.argv[4]))
  else throw new Error('Expected polling budget start, check or watch')
}
