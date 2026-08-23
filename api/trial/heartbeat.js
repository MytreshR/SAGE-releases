import { consume, isValidDeviceId, json, readJson, remainingMs } from '../_lib/trial.js'

/**
 * POST /api/trial/heartbeat  { deviceId, elapsedMs }  ->  { remainingMs }
 *
 * The app sends this while a session is actually capturing, and only then.
 * Metering here rather than by wall clock is what lets someone install SAGE
 * the night before and still have their full trial in the morning.
 *
 * The server caps each tick, so a client that sleeps for an hour and reports
 * it, or one edited to report a negative, moves the counter by at most one
 * interval. Nothing here trusts the number it is sent.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

  const { deviceId, elapsedMs } = await readJson(req)
  if (!isValidDeviceId(deviceId)) return json(res, 400, { error: 'bad-device-id' })

  const record = await consume(deviceId, elapsedMs)
  if (!record) return json(res, 404, { error: 'unknown-device' })

  return json(res, 200, { remainingMs: remainingMs(record) })
}
