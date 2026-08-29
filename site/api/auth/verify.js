import { checkCode, looksLikeEmail, remainingMs, signIn } from '../_lib/accounts.js'
import { isValidDeviceId, json, readJson } from '../_lib/trial.js'

/**
 * POST /api/auth/verify  { email, code, deviceId }  ->  { token, remainingMs }
 *
 * Exchanges a code for a session token, and makes this machine the account's
 * one signed-in device.
 *
 * Whatever was signed in before stops working on its next call. That is the
 * whole point: hours follow the person, so the only thing keeping one purchase
 * from being shared round an office is that it can only be in one place at a
 * time.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

  const { email, code, deviceId } = await readJson(req)
  if (!looksLikeEmail(email)) return json(res, 400, { error: 'bad-email' })
  if (!isValidDeviceId(deviceId)) return json(res, 400, { error: 'bad-device-id' })

  const checked = await checkCode(email, code)
  if (!checked.ok) {
    // The reason is returned because every one of them is something the person
    // can act on - ask for a new code, wait, or check they typed it right -
    // and none of them says whether the address has an account.
    return json(res, 401, { error: checked.reason, left: checked.left })
  }

  const { account, token } = await signIn(email, deviceId)

  console.log(`[auth] ${account.email} signed in on ${deviceId.slice(0, 8)}…`)
  return json(res, 200, {
    token,
    email: account.email,
    remainingMs: remainingMs(account),
    totalMs: account.grantedMs || 0
  })
}
