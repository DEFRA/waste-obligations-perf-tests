import { execFile, spawn } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function processSnapshot() {
  const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart='])
  return stdout.trim().split('\n').map(line => {
    const [pid, parent, group, state, ...started] = line.trim().split(/\s+/)
    return { pid: Number(pid), parent: Number(parent), group: Number(group), state, started: started.join(' ') }
  })
}

async function refreshOwnership(ownership) {
  const processes = await processSnapshot()
  const known = new Map((ownership.descendants ?? []).map(process => [process.pid, process.started]))
  if (ownership.rootProcess) known.set(ownership.rootProcess.pid, ownership.rootProcess.started)
  const groupMembers = processes.filter(process => process.group === ownership.processGroupId)
  if (groupMembers.length > 0 && !groupMembers.some(process => known.get(process.pid) === process.started)) {
    throw new Error('Owned workload process group identity no longer matches its saved identity')
  }
  const owned = new Set(processes.filter(process => process.group === ownership.processGroupId || known.get(process.pid) === process.started).map(process => process.pid))
  let changed
  do {
    changed = false
    for (const process of processes) {
      if (owned.has(process.parent) && !owned.has(process.pid)) { owned.add(process.pid); changed = true }
    }
  } while (changed)
  ownership.descendants = processes.filter(process => owned.has(process.pid)).map(({ pid, started }) => ({ pid, started }))
  return processes.filter(process => owned.has(process.pid) && !process.state.startsWith('Z'))
}

function saveOwnership(file, ownership) {
  writeFileSync(`${file}.tmp`, JSON.stringify(ownership))
  renameSync(`${file}.tmp`, file)
}

export async function terminateOwnedWorkload(groupFile, runId) {
  let ownership
  try { ownership = JSON.parse(await readFile(groupFile, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (ownership.runId !== runId || !Number.isSafeInteger(ownership.processGroupId) || ownership.processGroupId <= 1) throw new Error('Invalid owned workload process group')
  const ownedProcesses = await refreshOwnership(ownership)
  const signalDescendants = async name => {
    const current = await processSnapshot()
    for (const processInfo of ownedProcesses) {
      if (!current.some(process => process.pid === processInfo.pid && process.started === processInfo.started)) continue
      try { process.kill(processInfo.pid, name) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  await signalDescendants('SIGTERM')
  const deadline = Date.now() + 2000
  while ((await refreshOwnership(ownership)).length > 0 && Date.now() < deadline) await delay(50)
  await signalDescendants('SIGKILL')
  const reapingDeadline = Date.now() + 5000
  while (true) {
    if ((await refreshOwnership(ownership)).length === 0) break
    if (Date.now() >= reapingDeadline) throw new Error('Owned workload process group remains active after SIGKILL')
    await delay(50)
  }
  await unlink(groupFile).catch(error => { if (error.code !== 'ENOENT') throw error })
}

export async function runOwnedWorkload(command, args, cwd, groupFile, runId) {
  let requestedSignal
  let child
  let ownership
  let trackingTimer
  let tracking = Promise.resolve()
  let trackingBusy = false
  let trackingStopped = false
  let trackingStartedAt
  const refresh = async () => {
    if (ownership) { await refreshOwnership(ownership); saveOwnership(groupFile, ownership) }
  }
  const stop = signal => {
    requestedSignal = signal
    trackingStopped = true
    clearTimeout(trackingTimer)
    tracking.then(refresh).then(() => terminateOwnedWorkload(groupFile, runId)).catch(error => console.error(error.message))
  }
  const onTerm = () => stop('SIGTERM')
  const onInt = () => stop('SIGINT')
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)
  try {
    child = spawn(command, args, { cwd, detached: true, stdio: 'inherit' })
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    if (child.pid) {
      tracking = processSnapshot().then(processes => {
        const root = processes.find(process => process.pid === child.pid)
        if (!root) throw new Error('Cannot establish owned workload root process identity')
        ownership = { runId, processGroupId: child.pid, rootProcess: { pid: root.pid, started: root.started }, descendants: [] }
        saveOwnership(groupFile, ownership)
      })
      await tracking
      if (requestedSignal) stop(requestedSignal)
      // Capture early detached descendants during startup, then avoid sustained ps load.
      // Shutdown separately uses 50ms checks to confirm termination before releasing the lease.
      trackingStartedAt = Date.now()
      const track = () => {
        if (trackingBusy) return
        trackingBusy = true
        tracking = refresh().finally(() => {
          trackingBusy = false
          if (!trackingStopped) trackingTimer = setTimeout(track, Date.now() - trackingStartedAt < 1000 ? 50 : 1000)
        })
        tracking.catch(error => { console.error(error.message); child.kill('SIGTERM') })
      }
      trackingTimer = setTimeout(track, 50)
    }
    const result = await exit
    return requestedSignal || result.signal ? (requestedSignal === 'SIGINT' || result.signal === 'SIGINT' ? 130 : 143) : result.code
  } finally {
    trackingStopped = true
    clearTimeout(trackingTimer)
    await tracking
    await refresh()
    await terminateOwnedWorkload(groupFile, runId)
    process.off('SIGTERM', onTerm)
    process.off('SIGINT', onInt)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, groupFile, runId, cwd, command, ...args] = process.argv.slice(2)
  if (mode === 'run') process.exitCode = await runOwnedWorkload(command, args, cwd, groupFile, runId)
  else if (mode === 'stop') await terminateOwnedWorkload(groupFile, runId)
  else throw new Error('Expected owned workload run or stop')
}
