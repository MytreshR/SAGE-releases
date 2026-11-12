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

/** Longest a single metered call may deduct, so a stalled client cannot be
 *  billed for the hours it was asleep, and a forged one cannot drain someone's
 *  trial. Shared by all three ledgers. */
export const MAX_TICK_MS = 30_000

/**
 * How much a metered call costs, by the server's clock.
 *
 * This used to be the number the client sent in its heartbeat, capped at
 * MAX_TICK_MS. The cap stopped a client charging itself for an hour; nothing
 * stopped it charging itself for nothing. A build that sent elapsedMs: 0, or
 * sent no heartbeats at all, kept its whole balance for ever - while the chat
 * proxy and the realtime minter, which deducted nothing themselves, kept
 * answering it. Every one of those calls spends the vendor's money.
 *
 * So every metered call now charges for the wall-clock time since the ledger
 * last charged this device, capped the same way, and the client's number is
 * not consulted. An honest app pays exactly what it did: it heartbeats every
 * 20s while listening, and the gaps between its calls add up to the time it
 * listened. The one difference is the first call after a long silence, which
 * is charged one cap rather than nothing.
 */
export const tickFor = (record, now = Date.now()) =>
  Math.min(MAX_TICK_MS, Math.max(0, now - (record.lastSeenAt || now)))

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

  // lastSeenAt is deliberately NOT touched here. It is the clock the metered
  // calls charge from, and this endpoint is free and unauthenticated: a client
  // that could reset the clock by calling claim between answers would pay
  // nothing for them.
  return { record: existing, fresh: false }
}

export const remainingMs = (record) => Math.max(0, TRIAL_MS - (record.usedMs || 0))

/** Deducts the time since this device was last charged. Returns the record after. */
export async function consume(deviceId) {
  const key = keyFor(deviceId)
  const record = await get(key)
  if (!record) return null

  const now = Date.now()
  record.usedMs = (record.usedMs || 0) + tickFor(record, now)
  record.lastSeenAt = now
  await set(key, record)
  return record
}

/**
 * Whether the request says it carries JSON.
 *
 * The one check that turns a cross-site form post into a non-event. A page on
 * another origin can make a browser POST a form here with this site's cookies
 * attached, but a form can only be sent form-encoded or multipart; to send
 * application/json it would need a preflighted fetch, and this API answers no
 * preflight. So an endpoint that insists on JSON is reachable only by this
 * site's own pages and by the desktop app, both of which send it. Every
 * endpoint that sets or spends a cookie session checks this first.
 */
export const isJson = (req) =>
  String(req.headers['content-type'] || '')
    .toLowerCase()
    .startsWith('application/json')

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
 * The shared money-spending guard used to live here and checked the trial
 * only. It moved to _lib/quota.js when licences became metered: a licensed
 * device has almost always spent its trial, so a trial-only gate refuses the
 * people who paid. See requireQuota there.
 */
