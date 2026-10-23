import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { captureNotifications, notificationReport, readCapture } from './notification-capture.mjs'

test('report escapes recipient and personalisation and distinguishes acceptance from delivery', () => {
  const html = notificationReport({ notifications: [{ request: { email_address: '<script>x</script>', personalisation: { user: '<img onerror="x">' } } }], truncated: true })
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('INCOMPLETE'))
  assert.ok(html.includes('No email was sent'))
})

test('HTTP errors and a cursor reset cannot be reported as an empty successful capture', async () => {
  await assert.rejects(readCapture('http://stub', 0, async () => ({ ok: false, status: 404 })), /404/)
  await assert.rejects(readCapture('http://stub', 4, async () => ({ ok: true, json: async () => ({ instanceId: 'new', cursor: 0, truncated: false, notifications: [] }) })), /invalid or the stub restarted/)
})

test('capture uses a starting cursor and saves requests accepted afterwards; rejects restart and lost evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'notification-capture-'))
  let snapshot = { instanceId: 'first', cursor: 5, truncated: false, notifications: [] }
  const urls = []
  const fetcher = async url => { urls.push(new URL(url).pathname + new URL(url).search); return new Response(JSON.stringify(snapshot)) }
  const env = { EPR_AZURE_STUB_BASE_URL: 'http://stub', EPR_LOAD_TEST_RUN_ID: 'run-one', NOTIFICATION_CAPTURE_RESULTS_DIR: directory, NOTIFICATION_CAPTURE_WAIT_SECONDS: '0' }
  try {
    await captureNotifications('start', env, fetcher)
    snapshot = { ...snapshot, cursor: 6, notifications: [{ sequence: 6, runId: 'run-one', expiresAtUtc: '2026-10-24T12:00:00Z', request: { email_address: 'person@example.com', personalisation: { obligationYear: 2026 } } }] }
    await captureNotifications('finish', env, fetcher)
    assert.deepEqual(urls, ['/admin/notify/notifications?after=0&runId=run-one', '/admin/notify/notifications?after=5&runId=run-one'])
    const saved = JSON.parse(await readFile(path.join(directory, 'capture.json'), 'utf8'))
    assert.equal(saved.runId, 'run-one')
    assert.equal(saved.notifications[0].runId, 'run-one')
    assert.equal(saved.notifications[0].request.email_address, 'person@example.com')
    assert.ok((await readFile(path.join(directory, 'index.html'), 'utf8')).includes('person@example.com'))
    assert.ok((await readFile(path.join(directory, 'index.html'), 'utf8')).includes('2026-10-24T12:00:00Z'))
    await assert.rejects(captureNotifications('finish', { ...env, EPR_LOAD_TEST_RUN_ID: 'other-run' }, fetcher), /baseline belongs to a different run/)
    snapshot = { ...snapshot, notifications: [{ ...snapshot.notifications[0], runId: 'other-run' }] }
    await assert.rejects(captureNotifications('finish', env, fetcher), /requests from a different run/)
    snapshot = { ...snapshot, notifications: [{ ...snapshot.notifications[0], runId: 'run-one' }] }
    snapshot = { ...snapshot, instanceId: 'restarted' }
    await assert.rejects(captureNotifications('finish', env, fetcher), /restarted/)
    snapshot = { ...snapshot, instanceId: 'first', truncated: true }
    await assert.rejects(captureNotifications('finish', env, fetcher), /retention/)
    assert.ok((await readFile(path.join(directory, 'index.html'), 'utf8')).includes('INCOMPLETE'))
    await captureNotifications('start', env, fetcher)
    await assert.rejects(readFile(path.join(directory, 'index.html')), { code: 'ENOENT' })
    await assert.rejects(readFile(path.join(directory, 'capture.json')), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
