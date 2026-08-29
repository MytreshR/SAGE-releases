/**
 * What is on sale, in one place.
 *
 * The price, the hours and the tier band all have to agree, and they are read
 * by four things that could otherwise drift: the checkout session, the webhook
 * that mints the key, the success page, and the pricing table on the website.
 * A mismatch here is not a rendering bug - it sells five hours and grants
 * three, or charges for three and grants five.
 *
 * `band` must match TIER_HOURS in licence.js. That is the mapping the app
 * honours when the key is finally redeemed; everything else is just what the
 * customer was told.
 */
export const PACKS = [
  { hours: 3, amount: 1499, currency: 'usd', display: '$14.99', band: 1 },
  { hours: 5, amount: 1799, currency: 'usd', display: '$17.99', band: 2 }
]

/** Looked up by hours, tolerating the string a JSON body or a query gives. */
export const packFor = (hours) => PACKS.find((p) => p.hours === Number(hours)) || null

/**
 * Serials are allocated inside the pack's band, so the band is a billion and
 * the counter within it starts at 1. licence.js divides by this to read the
 * tier back off a serial it has never seen before.
 */
export const TIER_BAND = 1_000_000_000

/**
 * The first thousand serials in every band are reserved for keys minted by
 * hand - tools/make-keys.mjs and tools/issue-key.mjs, for comps, refunds,
 * testing and anything sold outside Stripe.
 *
 * Without this the webhook's counter starts at 1 and re-issues serials that
 * have already been printed to a CSV and possibly handed to someone. Two
 * people end up holding the same key, and the second to activate is told it
 * is already in use on another computer - having paid for it.
 *
 * A reservation costs nothing: the band is a billion wide.
 */
export const MANUAL_RESERVE = 1000
