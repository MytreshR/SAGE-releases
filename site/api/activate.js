import { createPrivateKey, sign } from 'crypto'
import { create, get } from './_lib/store.js'
import { isValidDeviceId, json, readJson } from './_lib/trial.js'
import { readKey } from './_lib/keys.js'
import { grant, hoursForSerial, msForSerial, remainingMs } from './_lib/licence.js'

/**
 * POST /api/activate  { key, deviceId }  ->  { token, serial, remainingMs }
 *
 * Redeems an activation key, once and once only.
 *
 * Two separate questions get answered here, and conflating them is the usual
 * way this goes wrong:
 *
 *   1. Is this a key we issued?  Answered by arithmetic - the key carries a
 *      truncated HMAC over its own serial. No database involved.
 *   2. Has it been used already? Answered by the ledger, which is the only
 *      thing that has to be stored, and only for keys actually redeemed.
 *
 * A redemption is bound to the machine that made it. The same machine may
 * redeem the same key again as often as it likes - that is a reinstall, not a
 * second sale - but a different machine is refused. Without that, one customer
 * could post their key publicly and every reader would have a working copy.
 *
 * What comes back is an Ed25519 signature over the serial and device, which
 * the app verifies offline from then on. The server is asked once, at
 * redemption, and never again: an interview on bad wifi must not depend on
 * this endpoint being reachable.
 */

const keyFor = (serial) => `sage:key:${serial}`

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

  const { key, deviceId } = await readJson(req)

  if (!isValidDeviceId(deviceId)) return json(res, 400, { error: 'bad-device-id' })
  // Names the missing variable rather than saying "misconfigured" and leaving
  // whoever set it up to guess between two. Names are not secrets; a wrong
  // guess here costs a redeploy each time.
  const missing = ['SAGE_KEY_SECRET', 'SAGE_ACTIVATION_PRIVATE_KEY'].filter(
    (name) => !process.env[name]
  )
  if (missing.length) {
    console.error('activation is not configured - missing', missing.join(', '))
    return json(res, 500, { error: 'server-misconfigured', missing })
  }

  const serial = readKey(process.env.SAGE_KEY_SECRET, key)
  if (serial === null) {
    // Deliberately the same answer for "made up" and "mistyped". Telling them
    // apart would let someone probe which prefixes are real.
    return json(res, 400, { error: 'invalid-key' })
  }

  const record = {
    serial,
    deviceId,
    activatedAt: new Date().toISOString()
  }

  // SETNX, not GET-then-SET: two machines redeeming the same key at the same
  // moment must not both be told they got it.
  const claimed = await create(keyFor(serial), record)

  if (!claimed) {
    const existing = await get(keyFor(serial))
    if (existing && existing.deviceId !== deviceId) {
      return json(res, 409, {
        error: 'key-already-used',
        activatedAt: existing.activatedAt
      })
    }
    // Same machine, coming back. Reinstalls and reactivations land here.
  }

  const token = signActivation(serial, deviceId)
  if (!token) return json(res, 500, { error: 'signing-failed' })

  // A licence is listening time rather than a permanent unlock, so redeeming
  // has to credit the balance as well as sign the token. How much is decided
  // by the serial's tier band - see licence.js.
  //
  // Keys stack - a second key on this machine is another five hours - but the
  // same key must only ever grant once. The clause above deliberately lets a
  // machine re-redeem its own key as often as it likes, because that is a
  // reinstall rather than a second sale, and without the serial list on the
  // record every reinstall would mint another five hours for free.
  const balance = await grant(deviceId, serial)

  return json(res, 200, {
    token,
    serial,
    remainingMs: remainingMs(balance),
    grantedMs: msForSerial(serial),
    hours: hoursForSerial(serial)
  })
}

/**
 * The signed payload is deliberately minimal: a serial and the device it
 * belongs to. Nothing about the customer travels back to the app, so a token
 * lifted off a disk identifies a machine and a sale, not a person.
 */
function signActivation(serial, deviceId) {
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(process.env.SAGE_ACTIVATION_PRIVATE_KEY, 'base64'),
      format: 'der',
      type: 'pkcs8'
    })
    const payload = `${serial}:${deviceId}`
    const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey)
    return `${payload}:${signature.toString('base64url')}`
  } catch (error) {
    console.error('activation signing failed', error)
    return null
  }
}
