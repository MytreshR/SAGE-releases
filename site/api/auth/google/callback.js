import { signInWeb } from '../../_lib/accounts.js'
import { exchangeCode, isGoogleConfigured, readState, statesMatch } from '../../_lib/oauth.js'
import { clearCookie, originOf, parseCookies, setSession } from '../../_lib/session.js'
import { STATE_COOKIE } from './start.js'

/**
 * GET /api/auth/google/callback?code=…&state=…  ->  302, signed in
 *
 * Step two. Everything that can go wrong here ends the same way - back on the
 * login page with a reason in the query string - because a stack trace in a
 * browser window is no use to the person reading it, and this is a page real
 * customers see when Google is having a bad morning.
 */

const fail = (res, reason) => {
  res.statusCode = 302
  res.setHeader('Location', `/login.html?error=${encodeURIComponent(reason)}`)
  return res.end()
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405
    return res.end('method-not-allowed')
  }
  if (!isGoogleConfigured()) return fail(res, 'google-not-configured')

  const origin = originOf(req)
  const url = new URL(req.url, origin)

  // Google says why it refused - most often that the person pressed Cancel on
  // the consent screen, which is not an error worth alarming them about.
  const denied = url.searchParams.get('error')
  if (denied) return fail(res, denied === 'access_denied' ? 'cancelled' : 'google-refused')

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return fail(res, 'bad-callback')

  // Both halves of the state check. The cookie proves this browser started the
  // sign-in; the signature proves this server issued the value and that it has
  // not been sitting in a link for a week.
  const cookies = parseCookies(req)
  if (!statesMatch(state, cookies[STATE_COOKIE])) return fail(res, 'state-mismatch')
  const parsed = readState(state)
  if (!parsed) return fail(res, 'state-expired')

  // Spent, whatever happens next.
  clearCookie(res, STATE_COOKIE)

  let email
  try {
    ;({ email } = await exchangeCode({
      code,
      // Must be byte-identical to the one sent in step one, or Google refuses
      // the exchange - it is part of what the code was issued against.
      redirectUri: `${origin}/api/auth/google/callback`
    }))
  } catch (error) {
    console.error('[auth] google exchange failed', error.message)
    return fail(res, 'google-failed')
  }

  // Signs the browser in and no device out - see signInWeb. Somebody checking
  // their balance must not end an interview running on their laptop.
  const { account, token } = await signInWeb(email)
  setSession(res, token)

  console.log(`[auth] ${account.email} signed in with google`)
  res.statusCode = 302
  res.setHeader('Location', parsed.next || '/account.html')
  return res.end()
}
