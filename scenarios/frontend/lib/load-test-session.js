import { randomUUID } from 'node:crypto'

const loadTestSessionPath =
  '/admin/load-test-sessions'

function requiredEnvironmentValue(name) {
  const value = process.env[name]

  if (!value) {
    throw new Error(`${name} must be set for the frontend load test`)
  }

  return value
}

function loadTestStubBaseUrl() {
  return requiredEnvironmentValue('EPR_AZURE_STUB_BASE_URL').replace(/\/$/, '')
}

export function loadTestUserMix() {
  const raw = process.env.LOAD_TEST_USER_COUNT ?? '40'
  const userCount = Number(raw)

  if (!Number.isInteger(userCount) || userCount < 1) {
    throw new Error(
      `LOAD_TEST_USER_COUNT must be a positive integer, got '${raw}'`
    )
  }

  const percentageRaw = process.env.LOAD_TEST_CSO_PERCENTAGE ?? '75'
  const complianceSchemePercentage = Number(percentageRaw)

  if (
    !Number.isFinite(complianceSchemePercentage) ||
    complianceSchemePercentage < 0 ||
    complianceSchemePercentage > 100
  ) {
    throw new Error(
      `LOAD_TEST_CSO_PERCENTAGE must be between 0 and 100, got '${percentageRaw}'`
    )
  }

  const complianceSchemeUserCount = Math.round(
    userCount * (complianceSchemePercentage / 100)
  )

  return {
    userCount,
    directProducerUserCount: userCount - complianceSchemeUserCount,
    complianceSchemeUserCount
  }
}

function loadTestRunId() {
  const value = process.env.EPR_LOAD_TEST_RUN_ID

  if (!value) {
    return randomUUID()
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('EPR_LOAD_TEST_RUN_ID must be a UUID')
  }

  return value
}

function findAllocations(response, userId, expectedCount) {
  const user = response?.users?.find((candidate) => candidate.userId === userId)

  if (!Array.isArray(user?.allocations)) {
    throw new Error(
      `The load-test stub did not return allocations for user ID ${userId}`
    )
  }

  if (user.allocations.length !== expectedCount) {
    throw new Error(
      `The load-test stub returned ${user.allocations.length} allocations for user ID ${userId}, expected ${expectedCount}`
    )
  }

  return user.allocations
}

export async function initialiseLoadTestSession() {
  const runId = loadTestRunId()
  const {
    complianceSchemeUserCount,
    directProducerUserCount,
    userCount
  } = loadTestUserMix()
  const response = await fetch(`${loadTestStubBaseUrl()}${loadTestSessionPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId,
      directProducerUserCount,
      complianceSchemeUserCount
    })
  })

  if (!response.ok) {
    throw new Error(
      `Load-test session initialisation failed: ${response.status} ${await response.text()}`
    )
  }

  const body = await response.json()

  if (
    body.runId !== runId ||
    body.userCount !== userCount ||
    body.directProducerUserCount !== directProducerUserCount ||
    body.complianceSchemeUserCount !== complianceSchemeUserCount
  ) {
    throw new Error('Load-test stub returned an unexpected session response')
  }

  const directProducerAllocations = findAllocations(
    body,
    '79d0deab-c22d-4c30-8082-508ff8dc1bd7',
    directProducerUserCount
  )
  const complianceSchemeAllocations = findAllocations(
    body,
    '579c319d-d552-47a2-bf4c-5a125a3183bc',
    complianceSchemeUserCount
  )

  return {
    runId,
    userCount,
    directProducerUserCount,
    complianceSchemeUserCount,
    directProducerAllocations,
    complianceSchemeAllocations
  }
}

export function loadTestSessionHeaders(runId, userIndex) {
  return { 'X-EPR-Load-Test-Session': `${runId}:${userIndex}` }
}
