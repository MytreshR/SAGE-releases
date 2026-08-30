import { authorizeUrl, isGoogleConfigured, makeState } from '../../_lib/oauth.js'
import { originOf, setCookie } from '../../_lib/session.js'

/**
 * GET /api/auth/google/start?next=/account.html  ->  302 to Google
 *
 * Step one of Sign in with Google. Issues a state value, puts a copy in a
 * short-lived cookie, and sends the browser on.
 *
 * The state has to be in both places for the callback to accept it. In the URL
 * alone it proves nothing - whoever crafted the link chose it. What makes it
 * work is that only a browser that started here has the cookie.
 */
export const STATE_COOKIE = 'sage_oauth_state'

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405
    return res.end('method-not-allowed')
  }

  if (!isGoogleConfigured()) {
    console.error('google sign-in requested but GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set')
    res.statusCode = 302
    res.setHeader('Location', '/login.html?error=google-not-configured')
    return res.end()
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
  res.setHeader('Location', authorizeUrl({
    redirectUri: `${origin}/api/auth/google/callback`,
    state
  }))
  return res.end()
}
