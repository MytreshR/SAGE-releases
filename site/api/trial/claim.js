import { balanceFor, tokenState } from '../_lib/quota.js'
import { claim, isValidDeviceId, json, readJson, remainingMs, TRIAL_MS } from '../_lib/trial.js'

/**
 * POST /api/trial/claim  { deviceId }  ->  { remainingMs, totalMs, ledger, fresh }
 *
 * Called once at app start. Registers the machine if it has never been seen
 * and reports what is left. Reinstalling produces the same deviceId, finds the
 * same record, and gets back whatever the first install left over - which is
 * the whole reason the ledger is here and not on their disk.
 *
 * Deliberately cheap and unauthenticated: it spends nothing, and rate limiting
 * a call that only reads a counter is not worth the complexity.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

  const body = await readJson(req)
  const { deviceId, appVersion } = body
  if (!isValidDeviceId(deviceId)) return json(res, 400, { error: 'bad-device-id' })

  // A device that has bought time - signed in, or holding a redeemed key - is
  // answered from that ledger, not the trial one. It has almost always spent
  // its trial, so answering with trial numbers would tell a paying customer
  // they have nothing left, and the client is built to distrust exactly that.
  // Which is what `ledger` is for.
  const { account, rejected } = await tokenState(req, body, deviceId)
  const bought = await balanceFor(deviceId, account)
  if (bought) {
    return json(res, 200, {
      remainingMs: bought.remainingMs,
      totalMs: bought.totalMs,
      ledger: bought.ledger,
      // So the app can show whose hours these are without a second round trip.
      email: bought.email ?? null,
      fresh: false
    })
  }

  // Signed in once, and no longer. Almost always because this person signed in
  // on another computer, which is exactly what accounts are for - but the app
  // has to be told, or it drops back to a trial spent months ago and looks
  // broken rather than moved.
  if (rejected) {
    return json(res, 200, {
      remainingMs: 0,
      totalMs: 0,
      ledger: 'account',
      signedOut: true,
      fresh: false
    })
  }

  const { record, fresh } = await claim(deviceId, appVersion ? { appVersion } : {})

  return json(res, 200, {
    remainingMs: remainingMs(record),
    totalMs: TRIAL_MS,
    ledger: 'trial',
    fresh
  })
}
