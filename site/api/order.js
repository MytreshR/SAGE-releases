import { get } from './_lib/store.js'
import { json, readJson } from './_lib/trial.js'
import { getCheckoutSession, isConfigured } from './_lib/stripe.js'

/**
 * POST /api/order  { sessionId }  ->  { key, hours, email }
 *
 * What the success page calls to show someone the key they just bought.
 *
 * Two independent checks stand between a session id and a key, because a
 * session id travels in a URL and URLs get shared, logged and guessed at:
 *
 *   1. The order must exist in our store, which only the verified webhook
 *      writes. A made-up id matches nothing.
 *   2. Stripe must agree the session is paid. This is the one that matters if
 *      an id ever leaks: knowing it is not the same as having paid for it.
 *
 * The webhook may not have landed yet - Stripe usually calls within a second,
 * but the browser can arrive first. That is answered with `pending` rather
 * than an error, and the page retries.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

  const { sessionId } = await readJson(req)
  if (typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
    return json(res, 400, { error: 'bad-session-id' })
  }

  if (!isConfigured()) return json(res, 500, { error: 'payments-not-configured' })

  // Ask Stripe first. If this is not a real, paid session there is nothing to
  // look up and nothing to leak.
  let session
  try {
    session = await getCheckoutSession(sessionId)
  } catch {
    return json(res, 404, { error: 'unknown-session' })
  }
  if (session?.payment_status !== 'paid') {
    return json(res, 402, { error: 'not-paid' })
  }

  const order = await get(`sage:order:${sessionId}`)
  if (!order) {
    // Paid, but the webhook has not been processed yet. Not an error - the
    // page waits and asks again.
    return json(res, 202, { pending: true })
  }

  // Deliberately narrow. The stored order carries the serial and the amount;
  // the buyer needs neither, and the serial is the one field that would let
  // somebody reason about how many have been sold.
  return json(res, 200, {
    key: order.key,
    hours: order.hours,
    email: order.email
  })
}
