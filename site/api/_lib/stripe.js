import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Stripe, over its REST API, with no SDK.
 *
 * The rest of this API is plain ESM with zero dependencies, which is what lets
 * it deploy without a build step and without a lockfile to keep current. Two
 * endpoints and a signature check do not justify breaking that: the SDK is
 * several megabytes to save writing one form-encoded POST.
 *
 * Everything here needs STRIPE_SECRET_KEY, and the webhook additionally needs
 * STRIPE_WEBHOOK_SECRET. Both are Vercel environment variables and neither
 * ever reaches the browser or the desktop app.
 */

const API = 'https://api.stripe.com/v1'

export const isConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY)

/**
 * Stripe takes form encoding, not JSON, and expresses nesting with brackets:
 * `line_items[0][price_data][unit_amount]`. Flattened here rather than at each
 * call site, because getting one bracket wrong produces a 400 that names a
 * parameter you did not think you were sending.
 */
function encode(value, prefix = '', out = new URLSearchParams()) {
  if (value === null || value === undefined) return out
  if (Array.isArray(value)) {
    value.forEach((item, i) => encode(item, `${prefix}[${i}]`, out))
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      encode(v, prefix ? `${prefix}[${k}]` : k, out)
    }
  } else {
    out.append(prefix, String(value))
  }
  return out
}

async function call(path, body, method = 'POST') {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body ? encode(body).toString() : undefined
  })

  const payload = await res.json().catch(() => null)
  if (!res.ok) {
    // Stripe's own message is the useful one - "No such price" rather than
    // "400" - and it is safe to log because it describes our request, not the
    // customer.
    const message = payload?.error?.message || `stripe ${res.status}`
    throw new Error(message)
  }
  return payload
}

/** Opens a hosted checkout page. Returns the session, whose `url` we redirect to. */
export const createCheckoutSession = (params) => call('/checkout/sessions', params)

/** Reads a session back, to answer "has this actually been paid for?" */
export const getCheckoutSession = (id) =>
  call(`/checkout/sessions/${encodeURIComponent(id)}`, null, 'GET')

/**
 * Verifies a webhook really came from Stripe.
 *
 * Without this the endpoint is an open door: anyone who guesses the URL can
 * POST a `checkout.session.completed` and be handed a key worth $17.99. The
 * signature is an HMAC over `timestamp.rawBody`, so it has to be checked
 * against the bytes as they arrived - parsing and re-serialising the JSON
 * changes them and the signature no longer matches.
 *
 * The timestamp is checked too. A signature stays valid forever on its own, so
 * a replayed request would mint a second key for a single payment.
 */
const TOLERANCE_S = 5 * 60

export function verifyWebhook(rawBody, signatureHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret || !signatureHeader) return null

  const parts = Object.fromEntries(
    String(signatureHeader)
      .split(',')
      .map((p) => p.split('=').map((s) => s.trim()))
      .filter((p) => p.length === 2)
  )
  const timestamp = Number(parts.t)
  const signature = parts.v1
  if (!timestamp || !signature) return null

  if (Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_S) return null

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex')

  // Constant time, and length-checked first: timingSafeEqual throws on a
  // length mismatch, which would itself leak whether the length was right.
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    return JSON.parse(rawBody)
  } catch {
    return null
  }
}

/**
 * The raw request body, as bytes.
 *
 * Deliberately not the parsed body: the signature is over exactly what was
 * sent, and `JSON.stringify(JSON.parse(x))` is not reliably `x` - key order
 * and number formatting both move.
 */
export async function readRaw(req) {
  if (typeof req.body === 'string') return req.body
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8')
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
