import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

/**
 * Sign in with Google, over its REST endpoints, with no SDK.
 *
 * Same reasoning as stripe.js and email.js: this API is plain ESM with no
 * dependencies and no build step, and the whole flow is two POSTs and a
 * base64 decode.
 *
 * Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, from a Web application
 * OAuth client in the Google Cloud console, with this deployment's
 * /api/auth/google/callback listed as an authorised redirect URI. Google
 * matches that string exactly - a preview deployment on a different host is
 * refused until its URL is added too.
 */

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'

export const isGoogleConfigured = () =>
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)

function secret() {
  const value = process.env.SAGE_SESSION_SECRET
  if (!value) throw new Error('SAGE_SESSION_SECRET is not set')
  return value
}

// --------------------------------------------------------------------- state

/**
 * The state parameter, signed rather than stored.
 *
 * It exists to stop somebody handing your browser a link that completes THEIR
 * sign-in in YOUR session - login CSRF, which ends with your purchases landing
 * in an account they control. The defence is that the callback must carry a
 * value this server issued moments ago, and the browser must present the same
 * value in a cookie.
 *
 * Signed with an expiry instead of being written to the store, because it is
 * single-use, short-lived, and a round trip to Redis on every click of a
 * sign-in button buys nothing a HMAC does not already give.
 */
const STATE_TTL_MS = 10 * 60 * 1000

export function makeState(next = '') {
  const payload = `${randomBytes(12).toString('hex')}:${Date.now()}:${next}`
  const signature = createHmac('sha256', secret()).update(payload).digest('base64url')
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature}`
}

/** Returns where to send the user afterwards, or null if the state is no good. */
export function readState(state) {
  if (typeof state !== 'string' || !state.includes('.')) return null
  const [encoded, signature] = state.split('.')
  let payload
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }

  const expected = createHmac('sha256', secret()).update(payload).digest('base64url')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature || '', 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const [, issuedAt, ...rest] = payload.split(':')
  if (Date.now() - Number(issuedAt) > STATE_TTL_MS) return null
  return { next: rest.join(':') || '' }
}

/** Constant-time compare of the state in the URL against the one in the cookie. */
export function statesMatch(fromUrl, fromCookie) {
  const a = Buffer.from(String(fromUrl || ''), 'utf8')
  const b = Buffer.from(String(fromCookie || ''), 'utf8')
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------- flow

export function authorizeUrl({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    // `openid email` and nothing else. SAGE needs to know which address this
    // is and has no use for a contact list or a profile photo, and every scope
    // asked for is one more thing the consent screen makes somebody agree to.
    scope: 'openid email',
    // Always show the chooser. Without this, somebody signed in to Google with
    // two accounts is silently given whichever one Google prefers, which is
    // how a person ends up buying hours on an account they did not mean to use.
    prompt: 'select_account',
    state
  })
  return `${AUTH}?${params}`
}

/**
 * Turns the one-time code into an email address.
 *
 * The id_token's signature is deliberately not verified here, and that is
 * correct rather than lazy: this token came straight back from Google's own
 * token endpoint, over TLS, on a request authenticated with our client secret.
 * Nothing untrusted has touched it, so there is no forgery for a signature
 * check to catch. (Verification is required in the other flow - an id_token
 * handed to us by a client - which is not what this is.)
 *
 * The claims inside are still checked, because those guard against a real
 * mistake: a token minted for a different application, or an address the
 * person has not proved they own.
 */
export async function exchangeCode({ code, redirectUri }) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  })

  const payload = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(payload?.error_description || payload?.error || `google ${res.status}`)
  }

  const idToken = payload?.id_token
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
    throw new Error('google returned no id_token')
  }

  let claims
  try {
    claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    throw new Error('google id_token could not be read')
  }

  // Minted for us, by Google, and still valid.
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error('id_token is for another app')
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) {
    throw new Error('id_token has the wrong issuer')
  }
  if (Number(claims.exp) * 1000 < Date.now()) throw new Error('id_token has expired')

  // The one that matters most. An account here IS an hours balance, and it is
  // found by email address - so an unverified address is somebody claiming to
  // be a person rather than being them. Google Workspace domains can issue
  // these, so it is not a theoretical case.
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    throw new Error('google has not verified that address')
  }
  if (!claims.email) throw new Error('google returned no email address')

  return { email: String(claims.email) }
}
