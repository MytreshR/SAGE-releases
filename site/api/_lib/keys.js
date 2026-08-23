import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Activation keys: short, self-proving, and generated without a database.
 *
 * The obvious way to sell a million keys is to generate a million rows and
 * look each one up. This does not do that. A key carries its own proof - a
 * truncated HMAC over its serial, keyed by a secret only this server holds -
 * so "is this a real key we issued?" is answered by arithmetic rather than
 * storage. The only thing the database ever holds is the far smaller list of
 * keys that have actually been redeemed.
 *
 * That matters beyond tidiness: a million pre-stored rows is a million rows to
 * migrate, back up, and keep in step with whatever was handed to customers,
 * and losing them would invalidate every key in the wild. Here the secret is
 * the whole of the truth, and keys can be minted offline, in any quantity, at
 * any time, by anyone holding it.
 *
 * Format: SAGE-XXXX-XXXX-XXXX-XXXX
 *   8 chars of serial (40 bits) + 8 chars of tag (40 bits), Crockford base32.
 *
 * Crockford because these get read aloud off a receipt and typed by hand: it
 * drops I, L, O and U, so there is no 0/O or 1/l confusion to support.
 * Guessing a valid key is 1 in ~10^12 per attempt, which rate limiting turns
 * into an unworkable attack rather than a cheap one.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Crockford's canonical substitutions, so a mistyped key still activates. */
const normalise = (raw) =>
  String(raw || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')

const toBase32 = (buf) => {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

const fromBase32 = (str) => {
  let bits = 0
  let value = 0
  const out = []
  for (const ch of str) {
    const idx = ALPHABET.indexOf(ch)
    if (idx === -1) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** 40-bit serial → 8 base32 chars. */
const serialBytes = (serial) => {
  const buf = Buffer.alloc(5)
  buf.writeUIntBE(serial, 0, 5)
  return buf
}

const tagFor = (secret, serialBuf) =>
  createHmac('sha256', secret).update(serialBuf).digest().subarray(0, 5)


/**
 * Serials are permuted before they go into a key.
 *
 * Unmasked, serial 1 renders as SAGE-0000-0001 and the holder can see they are
 * your first sale, with the next few serials obvious on sight. A fixed XOR
 * does not fix that: consecutive serials differ in one byte, so the masked
 * values differ in one byte too and the keys still visibly march in order.
 *
 * This is a four-round Feistel over the 40-bit serial space, with HMAC as the
 * round function. It is a genuine permutation - every serial maps to exactly
 * one masked value and back, no collisions, no lookup table - and consecutive
 * serials come out with no visible relationship at all.
 *
 * Not a security boundary; the tag is what stops forgery. This only stops a
 * key from being a readable sales counter.
 */
const HALF = 20n
const HALF_MASK = (1n << HALF) - 1n

const roundFn = (secret, round, value) => {
  const digest = createHmac('sha256', secret)
    .update(`sage-fpe-${round}-${value.toString(16)}`)
    .digest()
  return BigInt('0x' + digest.subarray(0, 4).toString('hex')) & HALF_MASK
}

const permute = (secret, serial, reverse = false) => {
  let left = (BigInt(serial) >> HALF) & HALF_MASK
  let right = BigInt(serial) & HALF_MASK
  const rounds = reverse ? [3, 2, 1, 0] : [0, 1, 2, 3]

  for (const round of rounds) {
    if (reverse) {
      // Forward maps (L,R) -> (R, L^F(R)). So to undo it, the incoming L *is*
      // the old R, and the old L is R^F(L) - the round function has to be fed
      // the incoming left, not the right.
      const previousLeft = right ^ roundFn(secret, round, left)
      right = left
      left = previousLeft
    } else {
      const nextLeft = right
      right = left ^ roundFn(secret, round, right)
      left = nextLeft
    }
  }
  return (left << HALF) | right
}

const maskSerial = (secret, buf) => {
  const out = Buffer.alloc(5)
  out.writeUIntBE(Number(permute(secret, buf.readUIntBE(0, 5))), 0, 5)
  return out
}

const unmaskSerial = (secret, buf) =>
  Number(permute(secret, buf.readUIntBE(0, 5), true))

const group = (s) => s.match(/.{1,4}/g).join('-')

/** Mints the key for one serial. Same secret and serial always give the same key. */
export function mintKey(secret, serial) {
  const masked = maskSerial(secret, serialBytes(serial))
  return `SAGE-${group(toBase32(masked) + toBase32(tagFor(secret, masked)))}`
}

/**
 * Checks a key is one we issued, and returns its serial.
 *
 * Only proves authenticity - never whether it has already been redeemed. That
 * question needs the ledger, and keeping the two separate is deliberate: this
 * function is pure and testable, and the replay check lives in one place.
 */
export function readKey(secret, raw) {
  const clean = normalise(raw).replace(/^SAGE/, '')
  if (clean.length !== 16) return null

  const serialBuf = fromBase32(clean.slice(0, 8))
  const tag = fromBase32(clean.slice(8))
  if (!serialBuf || !tag || serialBuf.length < 5 || tag.length < 5) return null

  const expected = tagFor(secret, serialBuf.subarray(0, 5))
  // Constant-time: a plain === leaks how much of the tag was right, which
  // turns 10^12 guesses into a few thousand.
  if (!timingSafeEqual(expected, tag.subarray(0, 5))) return null

  return unmaskSerial(secret, serialBuf.subarray(0, 5))
}
