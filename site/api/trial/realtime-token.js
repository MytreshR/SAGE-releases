import { requireQuota } from '../_lib/quota.js'
import { json } from '../_lib/trial.js'

/**
 * POST /api/trial/realtime-token  { deviceId }  ->  { token, expiresAt, remainingMs }
 *
 * Transcription runs over a WebSocket that a serverless function cannot sit in
 * the middle of, so this mints an OpenAI ephemeral client secret instead and
 * hands that to the app, which connects to OpenAI directly with it.
 *
 * The vendor's real key never leaves this function. What the client holds is
 * short-lived and scoped to one realtime session, so pulling it out of memory
 * buys minutes of transcription, not an account.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

  // Gated for licensed devices too, and refused once their balance is spent.
  // Transcription is the expensive half: without this an empty licence could
  // still open a realtime socket and keep billing.
  const gate = await requireQuota(req, res)
  if (!gate) return

  const upstream = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${gate.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      session: {
        type: 'transcription',
        audio: {
          input: {
            transcription: { model: process.env.SAGE_TRANSCRIBE_MODEL || 'gpt-live-transcribe' }
          }
        }
      }
    })
  })

  const payload = await upstream.json().catch(() => null)
  if (!upstream.ok || !payload) {
    console.error('realtime client secret failed', upstream.status, payload)
    return json(res, 502, { error: 'realtime-token-failed' })
  }

  return json(res, 200, {
    token: payload.value ?? payload.client_secret?.value,
    expiresAt: payload.expires_at ?? payload.client_secret?.expires_at ?? null,
    remainingMs: gate.remainingMs,
    ledger: gate.ledger
  })
}
