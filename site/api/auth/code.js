import { issueCode, looksLikeEmail, normalise } from '../_lib/accounts.js'
import { canSendEmail, sendLoginCode } from '../_lib/email.js'
import { incr } from '../_lib/store.js'
import { json, readJson } from '../_lib/trial.js'

/**
 * POST /api/auth/code  { email }  ->  { sent: true }
 *
 * Emails a six-digit sign-in code.
 *
 * Always answers the same way, whether or not the address has ever bought
 * anything. Saying "no account here" would turn this endpoint into a way of
 * asking whether a given person uses SAGE, which - given what SAGE is for - is
 * not a question strangers should be able to ask.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

  const { email } = await readJson(req)
  if (!looksLikeEmail(email)) return json(res, 400, { error: 'bad-email' })

  if (!canSendEmail()) {
    console.error('sign-in requested but RESEND_API_KEY / SAGE_FROM_EMAIL are not set')
    return json(res, 500, { error: 'email-not-configured' })
  }

  // Sending mail costs money and reputation, and an unthrottled endpoint that
  // sends mail to an address of the caller's choosing is a way to use us to
  // deliver junk to somebody else. Capped per address per hour.
  const bucket = `sage:codes:${normalise(email)}:${new Date().toISOString().slice(0, 13)}`
  const sentThisHour = await incr(bucket)
  if (sentThisHour > 5) {
    // Still answers success. A caller who can tell throttling apart from
    // sending can use it to probe which addresses are real.
    console.warn(`[auth] throttled code for ${normalise(email)}`)
    return json(res, 200, { sent: true })
  }

  try {
    const code = await issueCode(email)
    await sendLoginCode(normalise(email), code)
  } catch (error) {
    console.error('[auth] could not send a sign-in code', error.message)
    return json(res, 502, { error: 'send-failed' })
  }

  return json(res, 200, { sent: true })
}
