import { signInWeb } from '../../_lib/accounts.js'
import {
  authorizeUrl,
  exchangeCode,
  isGoogleConfigured,
  makeState,
  readState,
  statesMatch
} from '../../_lib/oauth.js'
import { clearCookie, originOf, parseCookies, setCookie, setSession } from '../../_lib/session.js'

/**
 * Sign in with Google: /api/auth/google/start and /callback.
 *
 * Both halves in one file, partly because Vercel's Hobby plan counts twelve
 * serverless functions per deployment and partly because they are two ends of
 * one conversation - the state cookie written by the first is the only thing
 * the second will accept, and keeping that agreement in one place is how it
 * stays true.
 */

/**
 * Where the state value is echoed back to us.
 *
 * The state has to be in both the URL and this cookie for the callback to
 * accept it. In the URL alone it proves nothing - whoever crafted the link
 * chose it. What makes it work is that only a browser which started at /start
 * has the cookie.
 */
const STATE_COOKIE = 'sage_oauth_state'

const bounce = (res, reason) => {
  res.statusCode = 302
  res.setHeader('Location', `/login.html?error=${encodeURIComponent(reason)}`)
  return res.end()
}

export default async function handler(req, res) {
  const step = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean).pop()

  if (req.method !== 'GET') {
    res.statusCode = 405
    return res.end('method-not-allowed')
  }
  if (step === 'start') return start(req, res)
  if (step === 'callback') return callback(req, res)

  res.statusCode = 404
  return res.end('unknown-step')
}

/**
 * GET /api/auth/google/start?next=/account.html  ->  302 to Google
 *
 * Issues a state value, puts a copy in a short-lived cookie, and sends the
 * browser on.
 */
function start(req, res) {
  if (!isGoogleConfigured()) {
    console.error(
      'google sign-in requested but GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set'
    )
    return bounce(res, 'google-not-configured')
  }

  const origin = originOf(req)
  const url = new URL(req.url, origin)

  // Where to land afterwards, and only ever somewhere on this site. Taking the
  // caller's word for a full URL would make this an open redirect: a link that
  // genuinely signs you in to SAGE and then drops you on a page of somebody
  // else's choosing, with our domain in the part of the address people read.
  const asked = url.searchParams.get('next') || '/account.html'
  const next = asked.startsWith('/') && !asked.startsWith('//') ? asked : '/account.html'

  const state = makeState(next)
  // Ten minutes, because that is how long the state is honoured for anyway.
  setCookie(res, STATE_COOKIE, state, { maxAge: 600 })

  res.statusCode = 302
  res.setHeader(
    'Location',
    authorizeUrl({ redirectUri: `${origin}/api/auth/google/callback`, state })
  )
  return res.end()
}

/**
 * GET /api/auth/google/callback?code=…&state=…  ->  302, signed in
 *
 * Everything that can go wrong here ends the same way - back on the login page
 * with a reason in the query string - because a stack trace in a browser window
 * is no use to the person reading it, and this is a page real customers see
 * when Google is having a bad morning.
 */
async function callback(req, res) {
  if (!isGoogleConfigured()) return bounce(res, 'google-not-configured')

  const origin = originOf(req)
  const url = new URL(req.url, origin)

  // Google says why it refused - most often that the person pressed Cancel on
  // the consent screen, which is not an error worth alarming them about.
  const denied = url.searchParams.get('error')
  if (denied) return bounce(res, denied === 'access_denied' ? 'cancelled' : 'google-refused')

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return bounce(res, 'bad-callback')

  // Both halves of the state check. The cookie proves this browser started the
  // sign-in; the signature proves this server issued the value and that it has
  // not been sitting in a link for a week.
  const cookies = parseCookies(req)
  if (!statesMatch(state, cookies[STATE_COOKIE])) return bounce(res, 'state-mismatch')
  const parsed = readState(state)
  if (!parsed) return bounce(res, 'state-expired')

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
    return bounce(res, 'google-failed')
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
