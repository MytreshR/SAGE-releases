import * as accounts from './accounts.js'
import * as licence from './licence.js'
import { claim, isValidDeviceId, json, readJson, remainingMs as trialRemaining } from './trial.js'

/**
 * Which pot a device spends from, and whose money pays for it.
 *
 * Every endpoint that costs the vendor money has to ask the same three
 * questions: who is this, do they have time left, and which OpenAI key funds
 * it. Asking them in one place is what stops the answers drifting apart
 * between the chat proxy and the realtime minter.
 *
 * There are three ledgers - the account, the device licence, and the
 * trial - and the order they are asked in is the whole design:
 *
 *   whichever POT HAS TIME wins, account before licence before trial.
 *
 * Not "account first if signed in", which strands someone who signed in to an
 * empty account while holding a perfectly good key on that machine. Not
 * "licence first", which ignores the hours somebody just bought. Only once
 * every pot is empty does it matter which one to name in the refusal, and then
 * the most specific wins, because "you have run out of the hours you bought"
 * and "your trial is over" send people to different places.
 *
 * The trial is checked last for the reason it always was: a paying customer
 * has almost always spent theirs, and checking it first would refuse them.
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

/**
 * The token the desktop app carries once somebody signs in.
 *
 * A header rather than a body field, so it rides along with a stock OpenAI
 * request body on the chat proxy exactly as the device id does.
 */
export const tokenFrom = (req, body = {}) => req.headers['x-sage-token'] || body.token || null

/**
 * What the token on this request amounts to.
 *
 * Three outcomes, and the third is the one worth keeping apart. A token that
 * no longer verifies almost always means the same thing: this person signed in
 * on another computer, and that is the whole point of hours following the
 * person. But it is indistinguishable from never having signed in at all
 * unless somebody says so - and silently dropping such a machine back onto its
 * spent trial, mid-interview, with nothing on screen, is the worst version of
 * a rule that is otherwise reasonable.
 */
export async function tokenState(req, body, deviceId) {
  const token = tokenFrom(req, body)
  if (!token) return { account: null, presented: false, rejected: false }

  let account = null
  try {
    account = await accounts.readToken(token, deviceId)
  } catch {
    // readToken needs SAGE_SESSION_SECRET. On a deployment without it, being
    // signed out is the right answer - not a 500 on every call from a build
    // that happens to send the header.
    account = null
  }
  return { account, presented: true, rejected: account === null }
}

/** The signed-in account, or null. Never throws on a bad token - that is a signed-out call. */
export async function accountFor(req, body, deviceId) {
  return (await tokenState(req, body, deviceId)).account
}

/**
 * The balance to report, without spending anything. Used by claim.
 *
 * Answers with the pot that has time in it, and falls back to naming the one
 * that is empty, so the app shows a signed-in user their account balance
 * rather than a trial they spent months ago.
 */
export async function balanceFor(deviceId, account = null) {
  const accountLeft = account ? accounts.remainingMs(account) : 0
  if (account && accountLeft > 0) {
    return {
      ledger: 'account',
      remainingMs: accountLeft,
      totalMs: account.grantedMs || 0,
      email: account.email,
      record: account
    }
  }

  const held = await licence.getLicence(deviceId)
  if (held && licence.remainingMs(held) > 0) {
    return {
      ledger: 'licence',
      remainingMs: licence.remainingMs(held),
      totalMs: licence.totalMs(held),
      record: held
    }
  }

  // Nothing left anywhere it has been bought. Name the account first if there
  // is one: a signed-in person with an empty balance needs the top-up page,
  // not a sentence about a device key they never had.
  if (account) {
    return {
      ledger: 'account',
      remainingMs: 0,
      totalMs: account.grantedMs || 0,
      email: account.email,
      record: account
    }
  }
  if (held) {
    return {
      ledger: 'licence',
      remainingMs: 0,
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

  const account = await accountFor(req, body, deviceId)
  const held = await licence.getLicence(deviceId)

  // Which OpenAI key funds this. An account and a licence are both revenue -
  // somebody paid - so they draw on the licensed key; only the trial is the
  // loss leader that has to be capped separately.
  const paid = Boolean(account) || Boolean(held)
  const apiKey = apiKeyFor(paid ? 'licence' : 'trial')
  if (!apiKey) {
    json(res, 500, { error: 'server-misconfigured' })
    return null
  }

  // Hours bought against the person, spent wherever they are signed in.
  const accountLeft = account ? accounts.remainingMs(account) : 0
  if (account && accountLeft > 0) {
    return {
      deviceId,
      body,
      ledger: 'account',
      apiKey,
      remainingMs: accountLeft,
      email: account.email,
      record: account
    }
  }

  // Hours bought against this machine, by redeeming a key.
  if (held) {
    const left = licence.remainingMs(held)
    if (left > 0) {
      return { deviceId, body, ledger: 'licence', apiKey, remainingMs: left, record: held }
    }
  }

  // Both bought pots are empty, so say which one to top up. The account wins
  // the naming because being signed in is the more recent, more deliberate
  // act - and because it is the one with somewhere to send them.
  if (account) {
    json(res, 402, {
      error: 'account-exhausted',
      remainingMs: 0,
      ledger: 'account',
      email: account.email
    })
    return null
  }
  if (held) {
    json(res, 402, { error: 'licence-exhausted', remainingMs: 0, ledger: 'licence' })
    return null
  }

  const { record } = await claim(deviceId)
  const left = trialRemaining(record)
  if (left <= 0) {
    json(res, 402, { error: 'trial-exhausted', remainingMs: 0, ledger: 'trial' })
    return null
  }
  return { deviceId, body, ledger: 'trial', apiKey, remainingMs: left, record }
}
