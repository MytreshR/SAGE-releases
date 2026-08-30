import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto'
import { get, set } from './store.js'
import { hoursForSerial } from './licence.js'

/**
 * Accounts: hours that follow the person, not the machine.
 *
 * The rest of this system is bound to hardware, deliberately - that is what
 * makes one trial per machine mean anything. Accounts exist for the case that
 * binding gets wrong: somebody without their own laptop, installing SAGE on an
 * office machine for one interview. Their hours should be there.
 *
 * The obvious cost is sharing. Hours pooled against an email are hours ten
 * people can pool into, and a shared login is cheaper per head the more people
 * share it - so the balance has to be tied to something scarcer than knowledge
 * of an email address. That is what `activeDevice` is: one machine at a time,
 * and logging in somewhere else turns the previous one off mid-session.
 *
 * The trial stays device-bound and always will. Moving it to accounts would
 * make it thirteen minutes per email address, and email addresses are free.
 */

/**
 * Accounts are keyed by a hash of the address, not the address itself.
 *
 * The store then holds no list of who has bought SAGE that is readable by
 * anyone who gets a look at it - which, given what this product is used for,
 * is a list worth not having. The address is still kept inside the record,
 * because support has to be able to answer an email, but you have to know an
 * address to find its record rather than being able to read them all off.
 */
const keyFor = (email) =>
  `sage:acct:${createHmac('sha256', secret()).update(normalise(email)).digest('hex').slice(0, 32)}`

const codeKeyFor = (email) =>
  `sage:code:${createHmac('sha256', secret()).update(normalise(email)).digest('hex').slice(0, 32)}`

export const normalise = (email) => String(email || '').trim().toLowerCase()

/** Good enough to reject a typo and a header injection; the code proves the rest. */
export const looksLikeEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalise(email))

function secret() {
  const value = process.env.SAGE_SESSION_SECRET
  if (!value) throw new Error('SAGE_SESSION_SECRET is not set')
  return value
}

// ----------------------------------------------------------------- sign-in

/** Codes are short-lived and few: this is typed by hand off a phone. */
const CODE_TTL_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 5

/**
 * Issues a login code, returning it so the caller can email it.
 *
 * Never returned to the browser. The whole point of a code is that it travels
 * by a channel only the address's owner can read.
 */
export async function issueCode(email) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  await set(codeKeyFor(email), {
    // Stored hashed. A store dump should not be a list of live login codes.
    hash: createHmac('sha256', secret()).update(code).digest('hex'),
    expiresAt: Date.now() + CODE_TTL_MS,
    attempts: 0
  })
  return code
}

/**
 * Checks a code. Wrong guesses are counted, because six digits is a million
 * possibilities and an unbounded guesser gets through a million of them.
 */
export async function checkCode(email, code) {
  const record = await get(codeKeyFor(email))
  if (!record) return { ok: false, reason: 'no-code' }
  if (Date.now() > record.expiresAt) return { ok: false, reason: 'expired' }
  if (record.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too-many-attempts' }

  const given = createHmac('sha256', secret()).update(String(code || '')).digest('hex')
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(record.hash, 'utf8')
  const match = a.length === b.length && timingSafeEqual(a, b)

  if (!match) {
    record.attempts++
    await set(codeKeyFor(email), record)
    return { ok: false, reason: 'wrong-code', left: MAX_ATTEMPTS - record.attempts }
  }

  // Burned on use. A code that still works after being used is a code that
  // works again out of somebody's inbox a week later.
  await set(codeKeyFor(email), { hash: '', expiresAt: 0, attempts: MAX_ATTEMPTS })
  return { ok: true }
}

// ---------------------------------------------------------------- accounts

const blank = (email) => ({
  email: normalise(email),
  createdAt: Date.now(),
  grantedMs: 0,
  usedMs: 0,
  serials: [],
  /** The one machine currently signed in. Rotating this signs the other out. */
  activeDevice: null,
  /** Changes on every sign-in, which is what invalidates the previous token. */
  session: null,
  /**
   * The browser's session, deliberately kept apart from the device's.
   *
   * Signing in on the website to look at a balance must not end an interview
   * that is happening right now. One nonce for both would mean exactly that:
   * opening the account page rotates `session`, and the desktop token stops
   * verifying on its next heartbeat - mid-answer, with no way to tell the user
   * why. So the desktop token names `session`, the website's names
   * `webSession`, and rotating either leaves the other alone.
   *
   * "One machine at a time" still holds, because it was only ever about the
   * thing that spends hours, and a browser tab spends none.
   */
  webSession: null,
  /**
   * Top-ups, oldest first. What the account page shows as receipts.
   *
   * Kept on the account rather than assembled from Stripe on each page load:
   * the balance and the list of what produced it have to agree, and the only
   * way to guarantee that is for the same write to do both.
   */
  txns: [],
  lastSeenAt: Date.now()
})

export async function getAccount(email) {
  const record = await get(keyFor(email))
  if (!record) return null
  // Accounts written before web sessions and receipts existed are missing both
  // fields. Filled in on read rather than by a migration pass, because there is
  // no way to enumerate accounts - the keys are hashes, which is the point.
  if (!Array.isArray(record.txns)) record.txns = []
  if (record.webSession === undefined) record.webSession = null
  return record
}

export async function ensureAccount(email) {
  const existing = await get(keyFor(email))
  if (existing) return existing
  const record = blank(email)
  await set(keyFor(email), record)
  return record
}

export async function saveAccount(record) {
  record.lastSeenAt = Date.now()
  await set(keyFor(record.email), record)
  return record
}

export const remainingMs = (account) =>
  account ? Math.max(0, (account.grantedMs || 0) - (account.usedMs || 0)) : 0

/**
 * Signs a device in, and every other device out.
 *
 * "One device at a time" is enforced here and nowhere else: the session nonce
 * is stored on the account and carried in the token, so the moment a new
 * sign-in rotates it, the old machine's token stops verifying on its next
 * call. No push, no revocation list - the old token simply describes a session
 * that is no longer the current one.
 */
export async function signIn(email, deviceId) {
  const account = await ensureAccount(email)
  account.activeDevice = deviceId
  account.session = randomBytes(16).toString('hex')
  await saveAccount(account)
  return { account, token: mintToken(account, deviceId) }
}

/**
 * Signs a browser in, and signs no device out.
 *
 * The counterpart to signIn, and the difference is the whole reason both
 * exist: this touches `webSession` only. Somebody checking their balance on
 * their phone while SAGE is listening on their laptop is the ordinary case,
 * not an attempt to share a licence, and it must not cost them the interview.
 *
 * A browser session does not rotate the previous one either, so the website
 * stays signed in on a phone and a desktop at once. Nothing here spends
 * hours; the scarce thing is still guarded by signIn.
 */
export async function signInWeb(email) {
  const account = await ensureAccount(email)
  if (!account.webSession) account.webSession = randomBytes(16).toString('hex')
  await saveAccount(account)
  return { account, token: mintWebToken(account) }
}

/**
 * Ends every session at once - browser and device.
 *
 * The one button on the account page that can actually cut off a machine, and
 * the reason it is there: an account is hours, and hours are money. If a
 * laptop is lost or a login shared with somebody it should not have been,
 * this is what takes it back. Rotating both nonces invalidates every token
 * already issued without needing a list of them.
 */
export async function signOutEverywhere(email) {
  const account = await getAccount(email)
  if (!account) return null
  account.session = randomBytes(16).toString('hex')
  account.webSession = randomBytes(16).toString('hex')
  account.activeDevice = null
  return saveAccount(account)
}

/**
 * A bearer token the app keeps. Signed rather than stored, so verifying it
 * costs one HMAC instead of a round trip - but bound to the account's current
 * session, so it is not valid a moment longer than the account says.
 */
export function mintToken(account, deviceId) {
  const payload = [normalise(account.email), deviceId, account.session, Date.now()].join(':')
  const signature = createHmac('sha256', secret()).update(payload).digest('base64url')
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature}`
}

/**
 * Reads a token back, or null.
 *
 * Checks three things, and all three matter: that we signed it, that it names
 * this machine, and that it names the account's current session. The last is
 * what makes signing in elsewhere take effect immediately rather than whenever
 * a token happens to expire.
 */
/**
 * Where a device token says which machine it names, a browser token says the
 * literal string `web`. A device id is 64 hex characters, so the two can never
 * be mistaken for each other by accident - and the checks below refuse the
 * swap deliberately, so a token for one cannot be presented as the other.
 */
const WEB = 'web'

/** Verifies our signature and splits the payload, or null. Shared by both readers. */
function openToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null
  const [encoded, signature] = token.split('.')
  let payload
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }

  const expected = createHmac('sha256', secret()).update(payload).digest('base64url')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature || '', 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const [email, subject, session] = payload.split(':')
  if (!email || !session) return null
  return { email, subject, session }
}

export async function readToken(token, deviceId) {
  const opened = openToken(token)
  if (!opened) return null
  const { email, subject, session } = opened

  // A browser token is not a device token. Both are signed by the same secret,
  // so without this a session minted by clicking "Sign in with Google" - which
  // proves an email address and nothing about a machine - would spend hours as
  // though it were the one signed-in device.
  if (subject === WEB) return null
  if (deviceId && subject !== deviceId) return null

  const account = await getAccount(email)
  if (!account || account.session !== session) return null
  return account
}

/**
 * A browser session. Signed the same way, checked against the other nonce.
 *
 * Carries no device, because the website is not a device: it reads a balance
 * and starts a checkout, and neither of those spends listening time.
 */
export function mintWebToken(account) {
  const payload = [normalise(account.email), WEB, account.webSession, Date.now()].join(':')
  const signature = createHmac('sha256', secret()).update(payload).digest('base64url')
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature}`
}

export async function readWebToken(token) {
  const opened = openToken(token)
  if (!opened) return null
  const { email, subject, session } = opened
  // And the mirror of the check above: a desktop token must not read an
  // account page, or a stolen one would be a login as well as a licence.
  if (subject !== WEB) return null

  const account = await getAccount(email)
  if (!account || !account.webSession || account.webSession !== session) return null
  return account
}

// ----------------------------------------------------------------- balance

/**
 * Credits a key's hours to an account. Same rules as the device ledger: keys
 * stack, and the same key never grants twice.
 */
export async function grantSerial(email, serial) {
  const account = await ensureAccount(email)
  if (account.serials.includes(serial)) return account
  account.serials.push(serial)
  account.grantedMs += hoursForSerial(serial) * 60 * 60 * 1000
  return saveAccount(account)
}

/**
 * Credits a purchase to an account, once.
 *
 * The signed-in path does not mint a key at all: hours land here and the app
 * spends them wherever the person is signed in. That is what makes them
 * portable, and it is also why this has to be idempotent - Stripe retries
 * webhooks, and delivering the same event twice must not buy the hours twice.
 * The checkout session id is the thing that makes a payment unique, so that is
 * what gets checked.
 *
 * Returns the account, with the top-up appended to its receipts. Balance and
 * receipts are written together in one save on purpose: they are two views of
 * the same fact, and a customer whose balance and history disagree has no way
 * to tell which one is lying.
 */
export async function credit(email, { hours, sessionId, amount, currency, source = 'stripe' }) {
  const account = await ensureAccount(email)

  if (sessionId && account.txns.some((t) => t.sessionId === sessionId)) {
    // Already credited. Not an error - this is Stripe redelivering, which is
    // ordinary and expected.
    return account
  }

  const ms = Math.round(Number(hours) * 60 * 60 * 1000)
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`refusing to credit ${hours} hours`)

  account.grantedMs += ms
  account.txns.push({
    id: randomBytes(8).toString('hex'),
    at: Date.now(),
    hours: Number(hours),
    ms,
    amount: amount ?? null,
    currency: currency ?? null,
    sessionId: sessionId ?? null,
    source
  })

  return saveAccount(account)
}

/**
 * Takes a top-up back off an account, after a refund or a dispute.
 *
 * The attack this closes is the same one revoke.js closes for keys: pay with a
 * stolen card, spend the hours the same afternoon, and let the real cardholder
 * dispute it three weeks later. Hours are the vendor's money the moment they
 * are used, so the balance has to move back when the payment does.
 *
 * Only ever removes what that payment actually added, and only once - the
 * reversal is recorded as its own entry, which is both the audit trail and the
 * idempotency check. Stripe sends a refund and a dispute for the same charge
 * often enough that debiting per delivery would take the hours twice.
 *
 * grantedMs can end up below usedMs, and that is deliberate: `remainingMs`
 * floors at zero, so an account that already spent disputed hours reads as
 * empty rather than going negative and quietly crediting itself back on the
 * next top-up.
 */
export async function debit(email, { sessionId, reason = 'refund' }) {
  const account = await getAccount(email)
  if (!account) return null

  const original = account.txns.find((t) => t.sessionId === sessionId && t.ms > 0)
  if (!original) return account
  if (account.txns.some((t) => t.reverses === original.id)) return account

  account.grantedMs = Math.max(0, (account.grantedMs || 0) - original.ms)
  account.txns.push({
    id: randomBytes(8).toString('hex'),
    at: Date.now(),
    hours: -original.hours,
    ms: -original.ms,
    amount: original.amount === null ? null : -original.amount,
    currency: original.currency,
    sessionId,
    source: reason,
    reverses: original.id
  })

  return saveAccount(account)
}

/** Spends listening time. Clamped to what was bought - see licence.js. */
export async function consume(email, elapsedMs) {
  const account = await getAccount(email)
  if (!account) return null
  const tick = Math.min(Math.max(0, Number(elapsedMs) || 0), 30_000)
  account.usedMs = Math.min((account.usedMs || 0) + tick, account.grantedMs || 0)
  return saveAccount(account)
}
