import { signOutEverywhere } from '../_lib/accounts.js'
import { accountFor, clearCookie, SESSION_COOKIE } from '../_lib/session.js'
import { json, readJson } from '../_lib/trial.js'

/**
 * POST /api/account/logout  { everywhere? }  ->  { ok: true }
 *
 * Plain sign-out just drops this browser's cookie. `everywhere` additionally
 * rotates both session nonces, which cuts off the signed-in desktop as well -
 * the button to press when a laptop is lost or a login has been shared with
 * somebody it should not have been.
 *
 * Answers ok either way. Somebody pressing sign-out when their session already
 * expired has got what they asked for, and an error would only be confusing.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

  const { everywhere } = await readJson(req)
  const account = await accountFor(req)

  if (account && everywhere === true) {
    await signOutEverywhere(account.email)
    console.log(`[auth] ${account.email} signed out everywhere`)
  }

  clearCookie(res, SESSION_COOKIE)
  return json(res, 200, { ok: true })
}
