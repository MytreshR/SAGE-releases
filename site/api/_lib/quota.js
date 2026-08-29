import * as licence from './licence.js'
import { claim, isValidDeviceId, json, readJson, remainingMs as trialRemaining } from './trial.js'

/**
 * Which pot a device spends from, and whose money pays for it.
 *
 * There are two ledgers now - the 13-minute trial and the metered licence -
 * and every endpoint that costs the vendor money has to ask the same three
 * questions: who is this, do they have time left, and which OpenAI key funds
 * it. Asking them in one place is what stops the answers drifting apart
 * between the chat proxy and the realtime minter.
 *
 * Licence first. A licensed device has almost always spent its trial, so
 * checking the trial first would refuse a paying customer.
 */

/**
 * Two keys so the two spends can be told apart in OpenAI's usage dashboard.
 * Trial spend is a loss leader to be capped hard; licence spend is
 * revenue-backed and should have a different ceiling. One blended number
 * cannot answer whether the price covers the cost.
 *
 * Falls back rather than failing when the licensed key is missing: a paying
 * customer mid-interview must not be broken by an env var nobody set. Logged
 * as an error because the fallback silently undoes the cost separation, which
 * is the whole reason the second key exists.
 */
function apiKeyFor(ledger) {
  if (ledger !== 'licence') return process.env.OPENAI_API_KEY || null
  if (process.env.OPENAI_API_KEY_LICENSED) return process.env.OPENAI_API_KEY_LICENSED
  console.error(
    'OPENAI_API_KEY_LICENSED is not set - licensed traffic is falling back to the trial key, ' +
      'and licence spend can no longer be told apart from trial spend'
  )
  return process.env.OPENAI_API_KEY || null
}

/** The device's balance, without spending anything. Used by claim. */
export async function balanceFor(deviceId) {
  const held = await licence.getLicence(deviceId)
  if (held) {
    return {
      ledger: 'licence',
      remainingMs: licence.remainingMs(held),
      totalMs: licence.totalMs(held),
      record: held
    }
  }
  return null
}

/**
 * Shared guard for the endpoints that spend money. Returns what the caller
 * needs, or ends the response and returns null.
 */
export async function requireQuota(req, res) {
  const body = await readJson(req)
  // Header first, so the chat endpoint can take a stock OpenAI request body and
  // stay usable as a plain `baseURL` from the SDK.
  const deviceId = req.headers['x-sage-device'] || body.deviceId

  if (!isValidDeviceId(deviceId)) {
    json(res, 400, { error: 'bad-device-id' })
    return null
  }

  const held = await licence.getLicence(deviceId)
  const ledger = held ? 'licence' : 'trial'

  const apiKey = apiKeyFor(ledger)
  if (!apiKey) {
    json(res, 500, { error: 'server-misconfigured' })
    return null
  }

  if (held) {
    const left = licence.remainingMs(held)
    if (left <= 0) {
      json(res, 402, { error: 'licence-exhausted', remainingMs: 0, ledger })
      return null
    }
    return { deviceId, body, ledger, apiKey, remainingMs: left, record: held }
  }

  const { record } = await claim(deviceId)
  const left = trialRemaining(record)
  if (left <= 0) {
    json(res, 402, { error: 'trial-exhausted', remainingMs: 0, ledger })
    return null
  }
  return { deviceId, body, ledger, apiKey, remainingMs: left, record }
}
