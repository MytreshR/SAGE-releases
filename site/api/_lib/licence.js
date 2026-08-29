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

/**
 * How much a key is worth, decided by its serial.
 *
 * There are two tiers on sale and a key has to say which it is. It cannot be
 * looked up: the whole point of the key format is that validity is answered by
 * arithmetic - a truncated HMAC over the serial - so keys can be minted
 * offline, in any quantity, with nothing stored until one is actually redeemed.
 * Adding a database lookup for the tier would throw that away.
 *
 * So the tier rides in the serial itself, as a band. The serial space is 40
 * bits, about 1.1 trillion, and a band is a billion - room for a thousand
 * tiers that will never be needed and a billion sales per tier that will never
 * happen.
 *
 * Band 0 is every key issued before tiers existed. Those were sold as a
 * permanent unlock, so they get the larger allowance rather than the smaller.
 */
export const TIER_BAND = 1_000_000_000

const TIER_HOURS = {
  0: 5, // legacy keys, issued before tiers
  1: 3, // $14.99
  2: 5 // $17.99
}

/** Hours a serial is worth, defaulting to the larger tier if the band is unknown. */
export const hoursForSerial = (serial) => TIER_HOURS[Math.floor(serial / TIER_BAND)] ?? 5

export const msForSerial = (serial) => hoursForSerial(serial) * 60 * 60 * 1000

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
  record.grantedMs += msForSerial(serial)
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
