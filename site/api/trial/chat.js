import { requireQuota } from '../_lib/quota.js'
import { json } from '../_lib/trial.js'

/**
 * POST /v1/chat/completions  ->  the OpenAI response, streamed
 *
 * Takes a stock OpenAI request body with the device id in an `x-sage-device`
 * header, so the app points the SDK's `baseURL` here and changes nothing else.
 * vercel.json rewrites /v1/chat/completions onto this file.
 *
 * Answers go through here rather than direct, because chat completions have no
 * ephemeral-credential equivalent - the only way to keep the vendor key off the
 * client is to be the one making the call.
 *
 * The upstream body is passed through so the app keeps every latency setting it
 * already tuned (Fast mode, reasoning effort, the prompt cache key). The stream
 * is piped back chunk by chunk: buffering it here would undo streaming and make
 * the trial feel slower than the paid product it is selling.
 */
export const config = { maxDuration: 60 }

const ALLOWED_MODELS = (process.env.SAGE_TRIAL_MODELS || 'gpt-5.6-luna,gpt-5.6-sol')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean)

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

  const gate = await requireQuota(req, res)
  if (!gate) return

  const body = gate.body
  if (!body || typeof body !== 'object' || !body.model) {
    return json(res, 400, { error: 'missing-body' })
  }

  // The vendor pays for these models and no others, on both ledgers. Without
  // this the endpoint is an open bill: anyone with a device id could point it
  // at the priciest model OpenAI sells and spend the vendor's money at their
  // own leisure.
  if (!ALLOWED_MODELS.includes(body.model)) {
    return json(res, 400, { error: 'model-not-allowed' })
  }

  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${gate.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!upstream.ok) {
    const detail = await upstream.text()
    console.error(`${gate.ledger} chat upstream`, upstream.status, detail.slice(0, 500))
    return json(res, upstream.status, { error: 'upstream-failed' })
  }

  res.statusCode = 200
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')

  if (!upstream.body) return res.end()

  for await (const chunk of upstream.body) res.write(Buffer.from(chunk))
  res.end()
}
