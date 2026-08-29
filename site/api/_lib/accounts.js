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
  lastSeenAt: Date.now()
})

export async function getAccount(email) {
  return (await get(keyFor(email))) || null
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
export async function readToken(token, deviceId) {
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

  const [email, tokenDevice, session] = payload.split(':')
  if (!email || !session) return null
  if (deviceId && tokenDevice !== deviceId) return null

  const account = await getAccount(email)
  if (!account || account.session !== session) return null
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

/** Spends listening time. Clamped to what was bought - see licence.js. */
export async function consume(email, elapsedMs) {
  const account = await getAccount(email)
  if (!account) return null
  const tick = Math.min(Math.max(0, Number(elapsedMs) || 0), 30_000)
  account.usedMs = Math.min((account.usedMs || 0) + tick, account.grantedMs || 0)
  return saveAccount(account)
}
