import { remainingMs } from '../_lib/accounts.js'
import { PACKS } from '../_lib/packs.js'
import { requireAccount } from '../_lib/session.js'
import { json } from '../_lib/trial.js'

/**
 * GET /api/account/me  ->  { email, balance, txns, packs }
 *
 * Everything the account page renders, in one call. One round trip rather than
 * three, because all of it comes off the same record and fetching it in pieces
 * only creates ways for the balance and the receipts that explain it to
 * disagree on screen.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method-not-allowed' })

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
