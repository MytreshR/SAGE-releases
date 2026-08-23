import { create, get, set } from './store.js'

/**
 * Trial rules, in one place.
 *
 * The budget is metered in milliseconds of ACTIVE session time, not wall clock
 * from first launch. Someone who installs SAGE the night before an interview
 * should still have their ten minutes the next morning - a wall-clock window
 * would expire unused and read as a broken product rather than a trial.
 */
export const TRIAL_MS = Number(process.env.SAGE_TRIAL_MS || 13 * 60 * 1000)

/** Longest a single heartbeat may deduct, so a stalled client cannot be billed
 *  for the hours it was asleep, and a forged one cannot drain someone's trial. */
const MAX_TICK_MS = 30_000

const keyFor = (deviceId) => `sage:trial:${deviceId}`

/**
 * A ceiling on how many NEW trials are issued in a day, across everyone.
 *
 * The key itself cannot be extracted - it never leaves this server. What an
 * attacker can do is invent device ids and claim thirteen free minutes each,
 * spending the vendor's money without ever seeing the credential. Per-device
 * metering does not stop that, because the device id is the thing being
 * forged.
 *
 * So the spend is capped globally instead. Genuine demand of a few hundred new
 * machines a day passes untouched; a script enumerating ids hits the ceiling
 * and every further claim is refused until tomorrow. Existing trials keep
 * working - the cap only refuses NEW ones, so real users mid-trial are never
 * cut off by someone else's abuse.
 *
 * Set SAGE_TRIAL_DAILY_CAP to 0 to disable. Pair it with a hard monthly budget
 * limit on the OpenAI key itself, which is the only backstop that holds if
 * this server is ever misconfigured.
 */
const DAILY_CAP = Number(process.env.SAGE_TRIAL_DAILY_CAP ?? 300)

const today = () => new Date().toISOString().slice(0, 10)

async function underDailyCap() {
  if (!DAILY_CAP) return true
  const key = `sage:trial:issued:${today()}`
  const count = (await get(key)) || 0
  if (count >= DAILY_CAP) return false
  await set(key, count + 1)
  return true
}

/** Device ids are hashes from the client; anything else is a malformed call. */
export const isValidDeviceId = (id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)

/**
 * The device's record, creating it on first sight. `fresh` distinguishes a
 * machine that has never run SAGE from one that has - which is what makes a
 * reinstall not hand out a second trial.
 */
export async function claim(deviceId, meta = {}) {
  const key = keyFor(deviceId)
  const record = {
    deviceId,
    usedMs: 0,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    ...meta
  }

  // Check the ceiling before minting, never after: the point is to not create
  // the row at all once the day's budget is gone.
  const existingFirst = await get(key)
  if (!existingFirst && !(await underDailyCap())) {
    return { record: { ...record, usedMs: TRIAL_MS }, fresh: false, capped: true }
  }

  const fresh = await create(key, record)
  if (fresh) return { record, fresh: true }

  const existing = await get(key)
  // A record that vanished between SETNX and GET (evicted, or a store wiped in
  // testing) is treated as new rather than erroring the client into a dead end.
  if (!existing) return { record, fresh: true }

  existing.lastSeenAt = Date.now()
  await set(key, existing)
  return { record: existing, fresh: false }
}

export const remainingMs = (record) => Math.max(0, TRIAL_MS - (record.usedMs || 0))

/** Deducts elapsed session time. Returns the record after the deduction. */
export async function consume(deviceId, elapsedMs) {
  const key = keyFor(deviceId)
  const record = await get(key)
  if (!record) return null

  const tick = Math.min(Math.max(0, Number(elapsedMs) || 0), MAX_TICK_MS)
  record.usedMs = (record.usedMs || 0) + tick
  record.lastSeenAt = Date.now()
  await set(key, record)
  return record
}

/** JSON body from a Vercel Node request, tolerating a raw stream. */
export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

export function json(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/**
 * Shared guard for the two endpoints that spend the vendor's money. Returns
 * the record, or ends the response and returns null.
 */
export async function requireLiveTrial(req, res) {
  const body = await readJson(req)
  // Header first, so the chat endpoint can take a stock OpenAI request body
  // and stay usable as a plain `baseURL` from the SDK.
  const deviceId = req.headers['x-sage-device'] || body.deviceId

  if (!isValidDeviceId(deviceId)) {
    json(res, 400, { error: 'bad-device-id' })
    return null
  }
  if (!process.env.OPENAI_API_KEY) {
    json(res, 500, { error: 'server-misconfigured' })
    return null
  }

  const { record } = await claim(deviceId)
  if (remainingMs(record) <= 0) {
    json(res, 402, { error: 'trial-exhausted', remainingMs: 0 })
    return null
  }
  return { record, body }
}
