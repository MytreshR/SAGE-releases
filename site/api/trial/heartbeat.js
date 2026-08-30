import * as accounts from '../_lib/accounts.js'
import * as licence from '../_lib/licence.js'
import { accountFor } from '../_lib/quota.js'
import { consume, isValidDeviceId, json, readJson, remainingMs } from '../_lib/trial.js'

/**
 * POST /api/trial/heartbeat  { deviceId, elapsedMs }  ->  { remainingMs, ledger }
 *
 * The app sends this while a session is actually capturing, and only then.
 * Metering here rather than by wall clock is what lets someone install SAGE
 * the night before and still have their full trial in the morning.
 *
 * The server caps each tick, so a client that sleeps for an hour and reports
 * it, or one edited to report a negative, moves the counter by at most one
 * interval. Nothing here trusts the number it is sent.
 *
 * Which pot the tick comes out of is decided the same way requireQuota decides
 * it - account, then licence, then trial, whichever has time. It has to be the
 * same order, or a session would be authorised against one balance and billed
 * to another, and the one being spent would not be the one counting down on
 * screen.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

  const body = await readJson(req)
  const { deviceId, elapsedMs } = body
  if (!isValidDeviceId(deviceId)) return json(res, 400, { error: 'bad-device-id' })

  // Signed in: the hours belong to the person, so they are spent wherever that
  // person is, not wherever the key was redeemed.
  const account = await accountFor(req, body, deviceId)
  if (account && accounts.remainingMs(account) > 0) {
    const after = await accounts.consume(account.email, elapsedMs)
    return json(res, 200, {
      remainingMs: accounts.remainingMs(after || account),
      ledger: 'account'
    })
  }

  // Licence next: a licensed device has almost always spent its trial, and
  // deducting from an empty trial would report zero and stop a paid session.
  const held = await licence.getLicence(deviceId)
  if (held && licence.remainingMs(held) > 0) {
    const after = await licence.consume(deviceId, elapsedMs)
    return json(res, 200, {
      remainingMs: licence.remainingMs(after || held),
      ledger: 'licence'
    })
  }

  // Signed in with nothing left. Answered as an empty account rather than
  // falling through to the trial, so the app says "top up" instead of
  // reporting a trial that ran out months ago.
  if (account) return json(res, 200, { remainingMs: 0, ledger: 'account' })
  if (held) return json(res, 200, { remainingMs: 0, ledger: 'licence' })

  const record = await consume(deviceId, elapsedMs)
  if (!record) return json(res, 404, { error: 'unknown-device' })

  return json(res, 200, { remainingMs: remainingMs(record), ledger: 'trial' })
}
