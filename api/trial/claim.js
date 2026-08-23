import { claim, isValidDeviceId, json, readJson, remainingMs, TRIAL_MS } from '../_lib/trial.js'

/**
 * POST /api/trial/claim  { deviceId }  ->  { remainingMs, totalMs, fresh }
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

  const { deviceId, appVersion } = await readJson(req)
  if (!isValidDeviceId(deviceId)) return json(res, 400, { error: 'bad-device-id' })

  const { record, fresh } = await claim(deviceId, appVersion ? { appVersion } : {})

  return json(res, 200, {
    remainingMs: remainingMs(record),
    totalMs: TRIAL_MS,
    fresh
  })
}
