import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { terminateOwnedWorkload } from './owned-workload.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('stopping the owned wrapper terminates its child and grandchild before it is reaped', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'owned-workload-'))
  const groupFile = path.join(directory, 'group.json')
  const heartbeat = path.join(directory, 'heartbeat')
  const module = fileURLToPath(new URL('./owned-workload.mjs', import.meta.url))
  const grandchild = `process.on('SIGTERM',()=>{});setInterval(()=>require('fs').appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`
  const child = `process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',detached:true});setInterval(()=>{},1000)`
  const wrapper = spawn(process.execPath, [module, 'run', groupFile, 'test-run', directory, process.execPath, '-e', child], { stdio: 'ignore' })
  const exit = new Promise(resolve => wrapper.once('close', (code, signal) => resolve({ code, signal })))
  try {
    const deadline = Date.now() + 5000
    while (true) {
      try { if ((await readFile(heartbeat, 'utf8')).length > 0) break } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (Date.now() >= deadline) throw new Error('Owned grandchild did not start')
      await delay(20)
    }
    wrapper.kill('SIGTERM')
    assert.equal((await exit).code, 143)
    const stopped = await readFile(heartbeat, 'utf8')
    await delay(100)
    assert.equal(await readFile(heartbeat, 'utf8'), stopped)
    await assert.rejects(readFile(groupFile), { code: 'ENOENT' })
  } finally {
    await terminateOwnedWorkload(groupFile, 'test-run')
    wrapper.kill('SIGKILL')
    await exit
    await rm(directory, { recursive: true, force: true })
  }
})

test('cleanup refuses a process-group record belonging to another run', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'owned-workload-'))
  const file = path.join(directory, 'group.json')
  try {
    await writeFile(file, JSON.stringify({ runId: 'other-run', processGroupId: process.pid }))
    await assert.rejects(terminateOwnedWorkload(file, 'this-run'), /Invalid owned/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stale saved identity cannot signal a benign process whose group reused the recorded ID', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'owned-workload-'))
  const groupFile = path.join(directory, 'group.json')
  const signalled = path.join(directory, 'signalled')
  const benign = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>require('fs').writeFileSync(${JSON.stringify(signalled)},'signal'));setInterval(()=>{},1000)`], { detached: true, stdio: 'ignore' })
  const exit = new Promise(resolve => benign.once('close', resolve))
  try {
    await delay(100)
    await writeFile(groupFile, JSON.stringify({ runId: 'stale-run', processGroupId: benign.pid,
      rootProcess: { pid: benign.pid, started: 'old process start identity' }, descendants: [] }))
    await assert.rejects(terminateOwnedWorkload(groupFile, 'stale-run'), /saved identity/)
    assert.doesNotThrow(() => process.kill(benign.pid, 0))
    await assert.rejects(readFile(signalled), { code: 'ENOENT' })
  } finally {
    benign.kill('SIGKILL')
    await exit
    await rm(directory, { recursive: true, force: true })
  }
})

test('signal before ownership-file publication reaps the wrapper without starting a descendant', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'owned-workload-'))
  const groupFile = path.join(directory, 'group.json')
  const heartbeat = path.join(directory, 'unexpected-child')
  const module = fileURLToPath(new URL('./owned-workload.mjs', import.meta.url))
  const wrapper = spawn(process.execPath, [module, 'run', groupFile, 'startup-run', directory,
    process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(heartbeat)},'started');setInterval(()=>{},1000)`], { stdio: 'ignore' })
  const exit = new Promise(resolve => wrapper.once('close', (code, signal) => resolve({ code, signal })))
  wrapper.kill('SIGTERM')
  try {
    const result = await exit
    assert.ok(result.signal === 'SIGTERM' || result.code === 143)
    await assert.rejects(readFile(groupFile), { code: 'ENOENT' })
    await assert.rejects(readFile(heartbeat), { code: 'ENOENT' })
  } finally {
    await terminateOwnedWorkload(groupFile, 'startup-run')
    await rm(directory, { recursive: true, force: true })
  }
})

test('normal parent exit also stops an owned orphan grandchild before wrapper completion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'owned-workload-'))
  const groupFile = path.join(directory, 'group.json')
  const heartbeat = path.join(directory, 'heartbeat')
  const module = fileURLToPath(new URL('./owned-workload.mjs', import.meta.url))
  const grandchild = `process.on('SIGTERM',()=>{});setInterval(()=>require('fs').appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`
  const child = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',detached:true});setTimeout(()=>process.exit(0),250)`
  const wrapper = spawn(process.execPath, [module, 'run', groupFile, 'normal-run', directory, process.execPath, '-e', child], { stdio: 'ignore' })
  const exit = new Promise(resolve => wrapper.once('close', code => resolve(code)))
  try {
    assert.equal(await exit, 0)
    const stopped = await readFile(heartbeat, 'utf8')
    await delay(100)
    assert.equal(await readFile(heartbeat, 'utf8'), stopped)
  } finally {
    await terminateOwnedWorkload(groupFile, 'normal-run')
    await rm(directory, { recursive: true, force: true })
  }
})
