import { remainingMs, signOutEverywhere } from '../_lib/accounts.js'
import { PACKS, packFor } from '../_lib/packs.js'
import {
  accountFor,
  clearCookie,
  originOf,
  requireAccount,
  SESSION_COOKIE
} from '../_lib/session.js'
import { createCheckoutSession, isConfigured } from '../_lib/stripe.js'
import { json, readJson } from '../_lib/trial.js'

/**
 * The account page's endpoints: /api/account/me, /checkout, /logout.
 *
 * One file for the same reason as auth/[action].js - Vercel's Hobby plan
 * counts twelve serverless functions per deployment, by file rather than by
 * route. The URLs are unchanged.
 */
export default async function handler(req, res) {
  const action = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean).pop()

  if (action === 'me') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method-not-allowed' })
    return me(req, res)
  }
  if (action === 'checkout') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })
    return checkout(req, res)
  }
  if (action === 'logout') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })
    return logout(req, res)
  }
  return json(res, 404, { error: 'unknown-action' })
}

/**
 * GET /api/account/me  ->  { email, balance, txns, packs }
 *
 * Everything the account page renders, in one call. One round trip rather than
 * three, because all of it comes off the same record and fetching it in pieces
 * only creates ways for the balance and the receipts that explain it to
 * disagree on screen.
 */
async function me(req, res) {
  const account = await requireAccount(req, res)
  if (!account) return

  return json(res, 200, {
    email: account.email,
    createdAt: account.createdAt,
    balance: {
      remainingMs: remainingMs(account),
      grantedMs: account.grantedMs || 0,
      usedMs: account.usedMs || 0
    },
    // Whether a machine is currently holding this account's sign-in. The page
    // uses it to say so plainly, because "one device at a time" is a rule
    // people should be able to see the effect of rather than discover.
    deviceSignedIn: Boolean(account.activeDevice),
    // Newest first is how receipts are read.
    txns: [...(account.txns || [])].reverse(),
    // Sent rather than hardcoded in the page, so the prices on the top-up
    // buttons cannot drift from the prices actually charged.
    packs: PACKS.map(({ hours, display, amount, currency }) => ({
      hours,
      display,
      amount,
      currency
    }))
  })
}

/**
 * POST /api/account/checkout  { hours }  ->  { url }
 *
 * Buying hours into an account, as opposed to /api/checkout, which sells the
 * same hours as a key for one machine.
 *
 * The difference that matters is on the other end: this session carries the
 * account's address in its metadata, and the webhook credits the balance
 * rather than minting anything. Nothing is issued that could be pasted
 * somewhere else, because there is no longer anything to paste - the hours are
 * attached to the person, and the person signs in.
 *
 * The address comes from the session cookie, never from the request body. A
 * client-supplied account is a client-chosen account, and the first person to
 * notice tops up somebody else's balance - or, more to the point, works out
 * that the endpoint will name any account they like in Stripe's metadata.
 */
async function checkout(req, res) {
  const account = await requireAccount(req, res)
  if (!account) return

  if (!isConfigured()) {
    console.error('account checkout called but STRIPE_SECRET_KEY is not set')
    return json(res, 500, { error: 'payments-not-configured' })
  }

  const { hours } = await readJson(req)
  const pack = packFor(hours)
  if (!pack) return json(res, 400, { error: 'unknown-pack', sold: PACKS.map((p) => p.hours) })

  const origin = originOf(req)

  try {
    const session = await createCheckoutSession({
      mode: 'payment',
      // Straight back to the account page, which polls until the webhook has
      // landed and the new balance is real. No key screen, because there is no
      // key - the hours are simply there.
      success_url: `${origin}/account.html?topup={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/account.html`,
      // Prefilled and fixed, so the receipt goes to the address that owns the
      // hours. Someone paying under one address and holding the balance under
      // another is a support ticket waiting to be filed.
      customer_email: account.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: pack.currency,
            unit_amount: pack.amount,
            product_data: {
              name: `SAGE - ${pack.hours} hours`,
              description: `${pack.hours} hours of live listening time, added to ${account.email}. Hours stack and do not expire.`,
              // See checkout.js: Managed Payments refuses a session without it.
              tax_code: process.env.SAGE_TAX_CODE || 'txcd_10103001'
            }
          }
        }
      ],
      metadata: {
        hours: String(pack.hours),
        // What tells the webhook to credit a balance instead of minting a key.
        // Written from the verified session at creation time, so by the time
        // Stripe hands it back there is nothing left for anyone to influence.
        accountEmail: account.email
      }
    })

    return json(res, 200, { url: session.url })
  } catch (error) {
    console.error('account checkout failed', error.message)
    return json(res, 502, { error: 'checkout-failed', detail: error.message })
  }
}

/**
 * POST /api/account/logout  { everywhere? }  ->  { ok: true }
 *
 * Plain sign-out just drops this browser's cookie. `everywhere` additionally
 * rotates both session nonces, which cuts off the signed-in desktop as well -
 * the button to press when a laptop is lost or a login has been shared with
 * somebody it should not have been.
 *
 * Answers ok either way. Somebody pressing sign-out when their session already
 * expired has got what they asked for, and an error would only be confusing.
 */
async function logout(req, res) {
  const { everywhere } = await readJson(req)
  const account = await accountFor(req)

  if (account && everywhere === true) {
    await signOutEverywhere(account.email)
    console.log(`[auth] ${account.email} signed out everywhere`)
  }

  clearCookie(res, SESSION_COOKIE)
  return json(res, 200, { ok: true })
}
