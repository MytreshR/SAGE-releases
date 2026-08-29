import { mintKey } from './_lib/keys.js'
import { get, incr, set } from './_lib/store.js'
import { json } from './_lib/trial.js'
import { MANUAL_RESERVE, packFor, TIER_BAND } from './_lib/packs.js'
import { readRaw, verifyWebhook } from './_lib/stripe.js'
import { revokeSerial } from './_lib/revoke.js'

/**
 * POST /api/stripe-webhook  ->  200
 *
 * Where a payment becomes a key. Stripe calls this; nothing else may.
 *
 * The signature check is not optional and not a formality. Without it this
 * endpoint is an open door - anyone who finds the URL can POST a
 * `checkout.session.completed` and be handed a key worth $17.99.
 *
 * Vercel does not parse the body for a plain Node function, which is what
 * makes verifying against the raw bytes possible. If that ever changes, the
 * signature will start failing on every call rather than passing on a forged
 * one, which is the right way round for a mistake like that to break.
 */
export const config = { api: { bodyParser: false } }

const keyFor = (sessionId) => `sage:order:${sessionId}`

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

  const raw = await readRaw(req)
  const event = verifyWebhook(raw, req.headers['stripe-signature'])
  if (!event) {
    console.warn('[stripe] rejected a webhook with a bad or missing signature')
    return json(res, 400, { error: 'bad-signature' })
  }

  // Money going back out. A key minted for a payment that was later refunded
  // or disputed has to stop working - otherwise the shape of the attack is
  // simply: pay with a stolen card, activate within seconds, spend the hours,
  // and let the real cardholder dispute it three weeks later.
  if (
    event.type === 'charge.refunded' ||
    event.type === 'charge.dispute.created' ||
    event.type === 'charge.dispute.funds_withdrawn'
  ) {
    const charge = event.data?.object
    // A dispute names the charge; a refund is the charge. Either way the
    // payment intent is what ties it back to the checkout session.
    const paymentIntent = charge?.payment_intent || charge?.charge?.payment_intent
    const order = paymentIntent ? await get(`sage:pi:${paymentIntent}`) : null

    if (!order) {
      console.warn(`[stripe] ${event.type} for an order we cannot find`, paymentIntent)
      return json(res, 200, { unmatched: true })
    }

    await revokeSerial(order.serial, event.type)
    return json(res, 200, { revoked: order.serial })
  }

  // Everything else Stripe sends is acknowledged and ignored. Answering 200 is
  // deliberate: a 4xx makes Stripe retry an event we will never care about,
  // and a retrying webhook eventually gets the endpoint disabled.
  if (event.type !== 'checkout.session.completed') {
    return json(res, 200, { ignored: event.type })
  }

  const session = event.data?.object
  const sessionId = session?.id
  if (!sessionId) return json(res, 200, { ignored: 'no-session-id' })

  // Stripe retries on any non-2xx and can deliver the same event twice even
  // without one. Minting per delivery would hand out two keys for one payment.
  const existing = await get(keyFor(sessionId))
  if (existing) {
    console.log(`[stripe] ${sessionId} already fulfilled as key #${existing.serial}`)
    return json(res, 200, { alreadyFulfilled: true })
  }

  // Trust the session's own status, not the event's name. A session can
  // complete without being paid - a delayed payment method, for instance -
  // and those must not mint anything until the money is actually there.
  if (session.payment_status !== 'paid') {
    console.log(`[stripe] ${sessionId} completed but payment_status=${session.payment_status}`)
    return json(res, 200, { pending: true })
  }

  const pack = packFor(session.metadata?.hours)
  if (!pack) {
    // Nothing sensible to mint. Logged loudly because it means somebody paid
    // and is about to be told nothing was bought.
    console.error(`[stripe] ${sessionId} has no usable pack metadata`, session.metadata)
    return json(res, 200, { error: 'unknown-pack' })
  }

  if (!process.env.SAGE_KEY_SECRET) {
    // 500 on purpose, so Stripe retries: the payment is real and the customer
    // is owed a key. Swallowing this would lose the sale silently.
    console.error('[stripe] SAGE_KEY_SECRET is not set - cannot mint a paid key')
    return json(res, 500, { error: 'server-misconfigured' })
  }

  // A sandbox purchase mints nothing real.
  //
  // Stripe's test card numbers are public, so while the deployment is in test
  // mode anyone who finds the Buy button can complete a purchase for free. A
  // placeholder is handed back instead of a key: nothing to activate, nothing
  // to leak, and no serial burned - the counter is not touched either, so the
  // numbering stays clean for real sales.
  //
  // SAGE_ALLOW_TEST_KEYS=1 turns real minting back on, for when the whole
  // chain needs testing end to end again.
  const placeholder = event.livemode !== true && process.env.SAGE_ALLOW_TEST_KEYS !== '1'

  let serial = null
  let key = 'SAGE-XXXX-XXXX-XXXX-XXXX'

  if (!placeholder) {
    // Atomic, because two people paying in the same second must not be handed
    // the same serial - which is the same key, and the second to activate is
    // told it is already in use on another computer.
    // Offset past the hand-minted range, so a sale can never be issued a serial
    // that has already been printed to a CSV and given to somebody.
    const withinBand = await incr(`sage:serial:${pack.band}`)
    serial = pack.band * TIER_BAND + MANUAL_RESERVE + withinBand
    key = mintKey(process.env.SAGE_KEY_SECRET, serial)
  }

  const order = {
    serial,
    key,
    placeholder,
    hours: pack.hours,
    amount: session.amount_total,
    currency: session.currency,
    email: session.customer_details?.email ?? null,
    sessionId,
    paymentIntent: session.payment_intent ?? null,
    // Which Stripe mode minted this. A sandbox purchase produces a genuinely
    // valid key - mintKey knows nothing about test versus live, and
    // SAGE_KEY_SECRET is one variable shared by both - so without recording
    // this, every test purchase leaves a real key in circulation that is
    // indistinguishable from a paid one. activate.js refuses these once the
    // deployment is running on a live Stripe key.
    livemode: event.livemode === true,
    paidAt: new Date().toISOString()
  }

  await set(keyFor(sessionId), order)

  // The by-serial and by-payment-intent records exist to answer support
  // questions and to revoke on a refund. A placeholder has neither a serial
  // nor anything to revoke, so it gets neither.
  if (!placeholder) {
    // Filed by serial, so a support question that arrives with a key rather
    // than a receipt can still be answered.
    await set(`sage:sale:${serial}`, order)
    // And by payment intent, because that is the only identifier a refund or a
    // dispute carries - neither of them mentions the checkout session at all.
    if (session.payment_intent) {
      await set(`sage:pi:${session.payment_intent}`, order)
    }
  }

  console.log(
    placeholder
      ? `[stripe] ${sessionId} -> placeholder, no key minted (test purchase, ${pack.hours}h)`
      : `[stripe] ${sessionId} -> key #${serial} (${pack.hours}h) for ${order.email}`
  )
  return json(res, 200, { fulfilled: true })
}
