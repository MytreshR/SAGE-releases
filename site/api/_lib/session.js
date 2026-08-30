import { readWebToken } from './accounts.js'
import { json } from './trial.js'

/**
 * Browser sessions: the cookie, and the guard every account endpoint uses.
 *
 * The desktop app carries its token in a header, because it is a program and
 * headers are what programs send. A browser cannot be trusted to hold a token
 * that way - anything readable by script is readable by any script that gets
 * onto the page - so the website's token lives in an HttpOnly cookie and the
 * page never sees it at all.
 *
 * The two are the same kind of token signed by the same secret, and
 * deliberately not interchangeable: see the WEB subject check in accounts.js.
 */

export const SESSION_COOKIE = 'sage_session'

/** How long a browser stays signed in. Long, because the balance is the point. */
const SESSION_MAX_AGE = 30 * 24 * 60 * 60

export function parseCookies(req) {
  const header = req.headers.cookie
  if (!header) return {}
  const out = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      // A cookie we did not write, with bytes that are not valid escaping.
      // Skipped rather than thrown: one malformed cookie from some other tool
      // on the domain must not make signing in impossible.
    }
  }
  return out
}

/**
 * Appends a Set-Cookie rather than replacing the header.
 *
 * The OAuth callback sets two in one response - the session, and the empty
 * state cookie it is retiring - and `setHeader` twice keeps only the second.
 * That failure is silent and looks like the state cookie never expiring.
 */
export function setCookie(res, name, value, { maxAge, httpOnly = true } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Lax',
    // Lax rather than Strict because the sign-in journey ends in a redirect
    // back from Google, and Strict withholds the cookie on exactly that
    // navigation - the user would arrive signed in and be shown a login page.
    'Secure'
  ]
  if (httpOnly) parts.push('HttpOnly')
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`)

  const existing = res.getHeader('Set-Cookie')
  const all = existing ? (Array.isArray(existing) ? [...existing, parts.join('; ')] : [existing, parts.join('; ')]) : [parts.join('; ')]
  res.setHeader('Set-Cookie', all)
}

export const setSession = (res, token) =>
  setCookie(res, SESSION_COOKIE, token, { maxAge: SESSION_MAX_AGE })

export const clearCookie = (res, name) => setCookie(res, name, '', { maxAge: 0 })

/**
 * The account behind this request, or null.
 *
 * Reads the cookie first and an Authorization header second. The header is
 * there for the desktop app, which opens the account page in a webview on some
 * platforms and has no cookie jar worth relying on.
 */
export async function accountFor(req) {
  const cookies = parseCookies(req)
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')
  const token = cookies[SESSION_COOKIE] || (bearer && bearer[1])
  if (!token) return null
  return readWebToken(token)
}

/** Guard for endpoints that need an account. Ends the response and returns null. */
export async function requireAccount(req, res) {
  const account = await accountFor(req)
  if (!account) {
    json(res, 401, { error: 'not-signed-in' })
    return null
  }
  return account
}

/** This deployment's own origin, so one build works on prod, preview and local. */
export function originOf(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  return `${proto}://${host}`
}
