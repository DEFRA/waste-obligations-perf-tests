// Pacing and think time for the PRN browser load test.
//
// Pacing fixes the rate: each user starts iteration n at
// (n - 1) × LOAD_TEST_PRN_ITERATION_PACING_MS after its own start, however
// fast the pages answer, so users × iterations run over iterations × pacing.
// An iteration that overruns its slot is followed straight away by the next
// and counted as late.
//
// With pacing, the users' starts are also spread evenly over one pacing
// interval (user k of n starts k × pacing / n after the first), so iterations
// start at a steady rate instead of all users together each interval.
//
// Think time is a pause before each step, as a person reads the page before
// acting. It isn't timed, and it is spread from half to one and a half times
// LOAD_TEST_PRN_THINK_TIME_MS so users don't act in step.

import { randomInt } from 'node:crypto'

const maxMilliseconds = 3_600_000

function wholeMilliseconds(variable) {
  const raw = process.env[variable] ?? '0'
  const value = Number(raw)

  if (!Number.isInteger(value) || value < 0 || value > maxMilliseconds) {
    throw new Error(`${variable} must be an integer between 0 and ${maxMilliseconds}, got '${raw}'`)
  }

  return value
}

export function iterationPacingMilliseconds() {
  return wholeMilliseconds('LOAD_TEST_PRN_ITERATION_PACING_MS')
}

export function thinkTimeMilliseconds() {
  return wholeMilliseconds('LOAD_TEST_PRN_THINK_TIME_MS')
}

// How long to wait before starting `iteration` (1-based) of a user that
// started at `userStartedAt`: 0 for the first, without pacing, or when the
// slot has already passed.
export function waitBeforeIteration({ iteration, userStartedAt, pacingMilliseconds, now }) {
  if (pacingMilliseconds === 0 || iteration === 1) return 0
  return Math.max(0, userStartedAt + (iteration - 1) * pacingMilliseconds - now)
}

// A think time between half and one and a half times `base`.
export function spreadThinkTime(base, random = randomInt) {
  if (base === 0) return 0
  return random(Math.floor(base / 2), Math.floor((base * 3) / 2) + 1)
}

// The start offset of the user at `position` (0-based) of `userCount`: evenly
// spread over one pacing interval, or 0 without pacing.
export function staggeredStartMilliseconds({ position, userCount, pacingMilliseconds }) {
  if (pacingMilliseconds === 0 || userCount === 0) return 0
  return Math.round((position * pacingMilliseconds) / userCount)
}
