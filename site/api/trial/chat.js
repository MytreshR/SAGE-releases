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

  // Sniff the usage totals on the way past, without buffering the stream.
  //
  // The client asks for stream_options.include_usage, so OpenAI sends one last
  // SSE event carrying the token counts - and until now it was piped straight
  // through and forgotten. That was fine when the customer's own key paid.
  // It is not fine now: this is the only place the vendor can see what an
  // answer actually cost, and "what does a licensed hour cost me" has no other
  // answer short of reading the dashboard and guessing at attribution.
  //
  // Only a rolling tail is kept, so a long answer costs nothing extra to watch
  // and the response is never delayed.
  let tail = ''
  for await (const chunk of upstream.body) {
    const buf = Buffer.from(chunk)
    res.write(buf)
    tail = (tail + buf.toString('utf8')).slice(-4000)
  }
  res.end()

  logUsage(gate, body.model, tail)
}

/**
 * One line per answer, in the Vercel logs, tagged by ledger so trial spend and
 * licence spend can be totted up separately. Wrapped in its own try: a logging
 * mistake must never take down an endpoint that has already answered.
 */
function logUsage(gate, model, tail) {
  try {
    // Brace-counted rather than matched by regex. The usage object nests
    // prompt_tokens_details inside it, and a regex that stops at the first
    // closing brace truncates the JSON one character short of valid - which is
    // exactly what it did, silently, until a test fed it a real event.
    const at = tail.lastIndexOf('"usage"')
    if (at === -1) return
    const open = tail.indexOf('{', at)
    if (open === -1) return

    let depth = 0
    let close = -1
    for (let i = open; i < tail.length; i++) {
      if (tail[i] === '{') depth++
      else if (tail[i] === '}' && --depth === 0) {
        close = i
        break
      }
    }
    if (close === -1) return

    const usage = JSON.parse(tail.slice(open, close + 1))
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
    console.log(
      `[usage] ledger=${gate.ledger} model=${model} ` +
        `prompt=${usage.prompt_tokens ?? 0} cached=${cached} ` +
        `completion=${usage.completion_tokens ?? 0} total=${usage.total_tokens ?? 0}`
    )
  } catch {
    /* usage is a nicety; never let it break the response */
  }
}
