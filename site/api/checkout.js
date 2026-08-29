import { json, readJson } from './_lib/trial.js'
import { createCheckoutSession, isConfigured } from './_lib/stripe.js'
import { PACKS, packFor } from './_lib/packs.js'

/**
 * POST /api/checkout  { hours }  ->  { url }
 *
 * Opens a Stripe hosted checkout page and hands back its URL for the browser
 * to follow. Nothing is minted here - a key is created only once Stripe says
 * the money arrived, which is the webhook's job. Minting on this call would
 * hand a key to anyone who clicked Buy and then closed the tab.
 *
 * The price is set here, from PACKS, rather than read from the request. A
 * client-supplied amount is a client-controlled amount, and the first person
 * to notice buys five hours for a cent.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

  if (!isConfigured()) {
    console.error('checkout called but STRIPE_SECRET_KEY is not set')
    return json(res, 500, { error: 'payments-not-configured' })
  }

  const { hours } = await readJson(req)
  const pack = packFor(hours)
  if (!pack) {
    return json(res, 400, { error: 'unknown-pack', sold: PACKS.map((p) => p.hours) })
  }

  // Where Stripe sends them afterwards. Taken from the request's own host so
  // this works on the production domain, on a preview deployment, and on
  // localhost without three different environment variables to keep in step.
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const origin = `${proto}://${host}`

  try {
    const session = await createCheckoutSession({
      mode: 'payment',
      // {CHECKOUT_SESSION_ID} is substituted by Stripe, not by us. The success
      // page needs it to ask which key was bought.
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/#pricing`,
      // Asked for because the key is worth money and losing it is a support
      // ticket: it lets the buyer be found again by the address they paid with.
      customer_creation: 'always',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: pack.currency,
            unit_amount: pack.amount,
            product_data: {
              name: `SAGE - ${pack.hours} hours`,
              description: `${pack.hours} hours of live listening time. Hours stack and do not expire.`
            }
          }
        }
      ],
      // Read back by the webhook. Written into the session at creation rather
      // than inferred from the amount later: a price change would silently
      // start granting the wrong tier to everyone who bought at the old one.
      metadata: { hours: String(pack.hours) }
    })

    return json(res, 200, { url: session.url })
  } catch (error) {
    console.error('checkout session failed', error.message)
    // Stripe's own message is returned, not just swallowed. It describes our
    // request - "Received unknown parameter: x" - never the customer, and
    // without it a failure here is only diagnosable from the Vercel logs,
    // which is a slow way to find a one-word mistake in a parameter name.
    return json(res, 502, { error: 'checkout-failed', detail: error.message })
  }
}
