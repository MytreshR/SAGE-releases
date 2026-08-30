import { checkCode, issueCode, looksLikeEmail, normalise, remainingMs, signIn, signInWeb } from '../_lib/accounts.js'
import { canSendEmail, sendLoginCode } from '../_lib/email.js'
import { setSession } from '../_lib/session.js'
import { incr } from '../_lib/store.js'
import { isValidDeviceId, json, readJson } from '../_lib/trial.js'

/**
 * Signing in: /api/auth/code, /api/auth/verify, /api/auth/web-verify.
 *
 * Three endpoints in one file because Vercel's Hobby plan counts twelve
 * serverless functions per deployment and counts them by FILE, not by route.
 * Splitting these three ways cost three of the twelve to no benefit - the URLs
 * are identical either way, which matters because installed copies of SAGE
 * already call /api/auth/code and /api/auth/verify and must keep working.
 *
 * The action is read off the path rather than from `req.query`, matching the
 * rest of this API: nothing here relies on the platform's request helpers, so
 * nothing here breaks if they change.
 */
export default async function handler(req, res) {
  const action = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean).pop()

  if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

  if (action === 'code') return sendCode(req, res)
  if (action === 'verify') return verifyDevice(req, res)
  if (action === 'web-verify') return verifyBrowser(req, res)
  return json(res, 404, { error: 'unknown-action' })
}

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
async function sendCode(req, res) {
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
async function verifyDevice(req, res) {
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

/**
 * POST /api/auth/web-verify  { email, code }  ->  { email, remainingMs }
 *
 * The browser's half of the email-code sign-in, and separate from the device's
 * for one reason: that one calls signIn, which makes the caller the account's
 * single active device and cuts off whatever was signed in before.
 *
 * Doing that from a web page would mean opening the account page to check a
 * balance kills the SAGE session running on the laptop - mid-interview, with
 * nothing on screen to explain it. So this signs a browser in and leaves the
 * device alone.
 *
 * No device id is asked for, and none is wanted. The website spends no hours.
 */
async function verifyBrowser(req, res) {
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
