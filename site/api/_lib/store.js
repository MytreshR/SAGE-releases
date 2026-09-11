/**
 * The trial ledger.
 *
 * This has to live on a server rather than on the user's disk. A local marker
 * - a file, a registry key, a hardware id in appData - is deleted by anyone
 * who wants a second trial, and the whole point of the requirement is that
 * uninstalling and reinstalling does not hand out another one.
 *
 * Upstash Redis over its REST API, because Vercel functions are short-lived
 * and cannot hold a socket pool. Two env vars and nothing else:
 *
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * With those unset it falls back to an in-process Map so `node api/dev.js`
 * runs locally with no external service. That fallback is per-process and
 * resets on restart - never deploy without the env vars, or every cold start
 * would issue everyone a fresh trial.
 */

const url = process.env.UPSTASH_REDIS_REST_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN

export const isPersistent = Boolean(url && token)

const memory = new Map()

async function command(...args) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  })
  if (!res.ok) throw new Error(`store ${res.status}: ${await res.text()}`)
  return (await res.json()).result
}

export async function get(key) {
  if (!isPersistent) return memory.get(key) ?? null
  const raw = await command('GET', key)
  return raw ? JSON.parse(raw) : null
}

export async function set(key, value) {
  if (!isPersistent) {
    memory.set(key, value)
    return
  }
  await command('SET', key, JSON.stringify(value))
}

/**
 * Atomic increment, returning the new value.
 *
 * This is how serials are handed out once keys are minted by a webhook rather
 * than by hand. GET-then-SET would be a race, and the failure is expensive and
 * silent: two people paying at the same moment get the same serial, which is
 * the same key, and the second to activate is told their key is already in use
 * on another computer. They paid and got a support ticket.
 */
export async function incr(key) {
  if (!isPersistent) {
    const next = (memory.get(key) ?? 0) + 1
    memory.set(key, next)
    return next
  }
  return Number(await command('INCR', key))
}

/**
 * Every key matching a pattern.
 *
 * SCAN rather than KEYS, which blocks the server for as long as it takes to
 * walk the whole space - fine on a laptop, a stall for every live session on a
 * shared instance.
 *
 * Bounded by `limit` because this exists for reporting, and a report is worth
 * far less than the sessions it would delay. Past the ceiling it stops and says
 * so, rather than walking a million keys to produce a number nobody needed to
 * be exact.
 */
export async function scan(pattern, limit = 5000) {
  // The dev fallback only ever sees prefix patterns like "sage:acct:*", so a
  // prefix match is the whole of what it needs and avoids escaping a glob into
  // a regular expression for no benefit.
  if (!isPersistent) {
    if (!pattern.endsWith('*')) {
      return { keys: memory.has(pattern) ? [pattern] : [], truncated: false }
    }
    const prefix = pattern.slice(0, -1)
    const keys = [...memory.keys()].filter((k) => k.startsWith(prefix))
    return { keys: keys.slice(0, limit), truncated: keys.length > limit }
  }

  const keys = []
  let cursor = '0'
  do {
    const [next, batch] = await command('SCAN', cursor, 'MATCH', pattern, 'COUNT', 1000)
    cursor = String(next)
    keys.push(...batch)
    if (keys.length >= limit) return { keys: keys.slice(0, limit), truncated: true }
  } while (cursor !== '0')

  return { keys, truncated: false }
}

/**
 * Several keys at once. One round trip instead of N, which is the difference
 * between a report that returns and a report that times out.
 */
export async function getMany(keys) {
  if (keys.length === 0) return []
  if (!isPersistent) return keys.map((k) => memory.get(k) ?? null)

  const out = []
  // Chunked: a single MGET of thousands of keys is one enormous request body.
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200)
    const raw = await command('MGET', ...chunk)
    out.push(...raw.map((v) => (v ? JSON.parse(v) : null)))
  }
  return out
}

/**
 * Create only if absent, reporting whether this call was the one that created
 * it. SETNX rather than GET-then-SET: two installers racing on the same
 * machine must not both be told they got a fresh trial.
 */
export async function create(key, value) {
  if (!isPersistent) {
    if (memory.has(key)) return false
    memory.set(key, value)
    return true
  }
  return (await command('SET', key, JSON.stringify(value), 'NX')) !== null
}
