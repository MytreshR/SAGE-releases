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
