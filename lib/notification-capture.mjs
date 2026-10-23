import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

export async function readCapture(baseUrl, after = 0, fetcher = fetch, runId) {
  const filter = runId ? `&runId=${encodeURIComponent(runId)}` : ''
  const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/admin/notify/notifications?after=${after}${filter}`, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`Notify capture returned HTTP ${response.status}`)
  const data = await response.json()
  if (typeof data.instanceId !== 'string' || !Number.isSafeInteger(data.cursor) || data.cursor < after ||
      typeof data.truncated !== 'boolean' || !Array.isArray(data.notifications)) {
    throw new Error('Notify capture response is invalid or the stub restarted')
  }
  if (runId && data.notifications.some(item => typeof item?.runId !== 'string' || item.runId.toLowerCase() !== runId.toLowerCase())) {
    throw new Error('Notify capture returned requests from a different run')
  }
  return data
}

export function notificationReport(data) {
  const rows = data.notifications.map(item => `<tr><td>${escape(item.runId)}</td><td>${escape(item.acceptedAtUtc)}<br>Expires: ${escape(item.expiresAtUtc)}</td><td>${escape(item.request.email_address)}</td><td>${escape(item.request.template_id)}</td><td>${escape(item.request.reference)}</td><td><pre>${escape(JSON.stringify(item.request.personalisation, null, 2))}</pre></td></tr>`).join('\n')
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Captured notification requests</title>
<style>body{font-family:system-ui;margin:2rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.5rem;text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere}td{overflow-wrap:anywhere}</style>
<h1>Captured notification requests</h1>
<p>${data.notifications.length} email requests accepted by the Azure stub while this run's lease was active, after the starting cursor.</p>
<p>No email was sent. Personalisation is shown as supplied; templates are not rendered. This snapshot does not establish that the notification queues drained or that every journey produced its expected emails.</p>
<p>Run: ${escape(data.runId)}. Window: ${escape(data.startedAtUtc)} to ${escape(data.finishedAtUtc)}.</p>
<p>The run ID identifies the active session at acceptance; delayed requests may originate from an earlier run.</p>
<p>${data.truncated ? 'INCOMPLETE: captured requests expired or exceeded the stub capacity.' : 'The stub retained all requests after the starting cursor.'}</p>
<p><a href="capture.json">Captured request data</a></p>
<table><thead><tr><th>Run ID</th><th>Accepted / expires at</th><th>Recipient</th><th>Template</th><th>Reference</th><th>Personalisation</th></tr></thead><tbody>${rows}</tbody></table></html>`
}

export async function captureNotifications(mode, env = process.env, fetcher = fetch) {
  const directory = path.resolve(env.NOTIFICATION_CAPTURE_RESULTS_DIR || 'results/notifications')
  const baselineFile = path.join(directory, 'baseline.json')
  if (!env.EPR_AZURE_STUB_BASE_URL) throw new Error('EPR_AZURE_STUB_BASE_URL is required')
  if (!env.EPR_LOAD_TEST_RUN_ID) throw new Error('EPR_LOAD_TEST_RUN_ID is required')
  if (mode === 'start') {
    await mkdir(directory, { recursive: true })
    await Promise.all(['baseline.json', 'index.html', 'capture.json'].map(file => rm(path.join(directory, file), { force: true })))
    const snapshot = await readCapture(env.EPR_AZURE_STUB_BASE_URL, 0, fetcher, env.EPR_LOAD_TEST_RUN_ID)
    await writeFile(baselineFile, JSON.stringify({ instanceId: snapshot.instanceId, cursor: snapshot.cursor, startedAtUtc: new Date().toISOString(), runId: env.EPR_LOAD_TEST_RUN_ID }))
    return
  }
  if (mode !== 'finish') throw new Error('Expected start or finish')
  const baseline = JSON.parse(await readFile(baselineFile, 'utf8'))
  if (baseline.runId?.toLowerCase() !== env.EPR_LOAD_TEST_RUN_ID.toLowerCase()) throw new Error('Notify capture baseline belongs to a different run')
  const waitSeconds = Number(env.NOTIFICATION_CAPTURE_WAIT_SECONDS ?? 30)
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 120) throw new Error('NOTIFICATION_CAPTURE_WAIT_SECONDS must be an integer from 0 to 120')
  await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000))
  const snapshot = await readCapture(env.EPR_AZURE_STUB_BASE_URL, baseline.cursor, fetcher, baseline.runId)
  if (snapshot.instanceId !== baseline.instanceId) throw new Error('The stub restarted during notification capture')
  const data = { ...snapshot, runId: baseline.runId, startedAtUtc: baseline.startedAtUtc, finishedAtUtc: new Date().toISOString() }
  await writeFile(path.join(directory, 'capture.json'), JSON.stringify(data, null, 2))
  await writeFile(path.join(directory, 'index.html'), notificationReport(data))
  if (data.truncated) throw new Error('Notify capture expired or exceeded stub retention capacity; the saved report is incomplete')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  captureNotifications(process.argv[2]).catch(async error => {
    console.error(error.message)
    process.exitCode = 1
    const directory = path.resolve(process.env.NOTIFICATION_CAPTURE_RESULTS_DIR || 'results/notifications')
    try {
      // Keep a more detailed incomplete snapshot when overflow already produced one.
      await readFile(path.join(directory, 'index.html'))
    } catch {
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Notification capture failed</title><h1>Notification capture failed</h1><p>${escape(error.message)}</p><p>No complete acceptance snapshot is available.</p></html>`)
    }
  })
}
