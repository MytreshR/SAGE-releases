import { get, set } from './store.js'

/**
 * The licence ledger: hours bought, hours spent.
 *
 * A licence used to be a permanent unlock, and the customer then ran on their
 * own OpenAI key - so the vendor paid for trials and nothing else, and there
 * was nothing to meter. Selling time instead moves the inference cost back onto
 * the vendor for every licensed minute, which is exactly the situation the
 * trial ledger already exists to handle. So this is that ledger again, with a
 * different way of being topped up.
 *
 * Metered in milliseconds of ACTIVE LISTENING, not wall clock and not session
 * time. A session sitting open with capture stopped holds no transcription
 * socket and makes no completions; billing it would charge for a coffee break.
 *
 * Balance lives here rather than in the activation token for the obvious
 * reason: a balance inside a signed token is stale the moment it is issued, and
 * a balance on the customer's disk is one they can edit.
 */

/** One key buys this much. 5 hours, matching the $14.99 the page sells. */
export const LICENCE_MS = Number(process.env.SAGE_LICENCE_MS || 5 * 60 * 60 * 1000)

/**
 * Longest a single heartbeat may deduct. Same reasoning as the trial's cap and
 * the same number: a client that slept for an hour, or one edited to report
 * one, moves the counter by at most one interval.
 */
const MAX_TICK_MS = 30_000

const keyFor = (deviceId) => `sage:licence:${deviceId}`

/**
 * The device's licence record, or null if it has never activated one.
 *
 * Null is what makes a device fall through to the trial ledger, so this is the
 * question that decides which pot every other call spends from.
 */
export async function getLicence(deviceId) {
  return (await get(keyFor(deviceId))) || null
}

/**
 * Adds one key's worth of time to a device.
 *
 * Keys stack: a second key on the same machine is another five hours, not a
 * refusal. But the SAME key must only ever grant once, and activate.js
 * deliberately lets a machine re-redeem its own key as often as it likes -
 * that is a reinstall, not a second sale. So the serials already counted are
 * kept on the record and checked here rather than being inferred from the
 * balance, which cannot tell a reinstall from a top-up.
 */
export async function grant(deviceId, serial) {
  const key = keyFor(deviceId)
  const now = Date.now()
  const record = (await get(key)) || {
    deviceId,
    grantedMs: 0,
    usedMs: 0,
    serials: [],
    createdAt: now,
    lastSeenAt: now
  }

  if (record.serials.includes(serial)) {
    // Already counted. Returning the record unchanged rather than erroring:
    // from the app's side this is an ordinary reactivation and it worked.
    return record
  }

  record.serials.push(serial)
  record.grantedMs += LICENCE_MS
  record.lastSeenAt = now
  await set(key, record)
  return record
}

export const remainingMs = (record) =>
  record ? Math.max(0, (record.grantedMs || 0) - (record.usedMs || 0)) : 0

export const totalMs = (record) => (record ? record.grantedMs || 0 : 0)

/** Deducts elapsed listening time. Returns the record after the deduction. */
export async function consume(deviceId, elapsedMs) {
  const key = keyFor(deviceId)
  const record = await get(key)
  if (!record) return null

  const tick = Math.min(Math.max(0, Number(elapsedMs) || 0), MAX_TICK_MS)

  // Clamped to what was actually bought: you cannot spend more time than you
  // hold. Without this the counter runs past the balance - a heartbeat deducts
  // before anything checks, so a client that ignores the stop, or two sessions
  // racing, push usedMs beyond grantedMs. The balance still reads zero, so
  // nothing looks wrong, and then the overshoot is quietly taken out of the
  // NEXT key the customer buys: they pay for five hours and get four and a
  // half. Found by a test that drained a licence and topped it up again.
  record.usedMs = Math.min((record.usedMs || 0) + tick, record.grantedMs || 0)
  record.lastSeenAt = Date.now()
  await set(key, record)
  return record
}
