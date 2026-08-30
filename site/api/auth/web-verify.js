import { checkCode, looksLikeEmail, remainingMs, signInWeb } from '../_lib/accounts.js'
import { setSession } from '../_lib/session.js'
import { json, readJson } from '../_lib/trial.js'

/**
 * POST /api/auth/web-verify  { email, code }  ->  { email, remainingMs }
 *
 * The browser's half of the email-code sign-in. /api/auth/verify is the
 * desktop's, and they are separate for one reason: that one calls signIn,
 * which makes the caller the account's single active device and cuts off
 * whatever was signed in before.
 *
 * Doing that from a web page would mean opening the account page to check a
 * balance kills the SAGE session running on the laptop - mid-interview, with
 * nothing on screen to explain it. So this signs a browser in and leaves the
 * device alone.
 *
 * No device id is asked for, and none is wanted. The website spends no hours.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

  const { email, code } = await readJson(req)
  if (!looksLikeEmail(email)) return json(res, 400, { error: 'bad-email' })

  const checked = await checkCode(email, code)
  if (!checked.ok) return json(res, 401, { error: checked.reason, left: checked.left })

  const { account, token } = await signInWeb(email)
  // HttpOnly, so the page it signs in never gets to read it back.
  setSession(res, token)

  console.log(`[auth] ${account.email} signed in to the website`)
  return json(res, 200, {
    email: account.email,
    remainingMs: remainingMs(account)
  })
}
