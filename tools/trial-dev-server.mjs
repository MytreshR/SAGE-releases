/**
 * Runs the trial endpoints locally, so the ledger can be exercised without a
 * deploy: `node tools/trial-dev-server.mjs`, then point SAGE_TRIAL_API at it.
 *
 * Lives outside api/ deliberately: it serves the trial endpoints over plain
 * HTTP with no auth, and anything under api/ is a live route on Vercel.
 *
 * Vercel routes files under api/ by path; this reproduces that mapping and
 * nothing else. Not used in production.
 */
import { createServer } from 'node:http'

import chat from '../api/trial/chat.js'
import claim from '../api/trial/claim.js'
import heartbeat from '../api/trial/heartbeat.js'
import realtimeToken from '../api/trial/realtime-token.js'
import { isPersistent } from '../api/_lib/store.js'

const routes = {
  '/api/trial/claim': claim,
  '/api/trial/heartbeat': heartbeat,
  '/api/trial/realtime-token': realtimeToken,
  '/api/trial/chat': chat
}

const port = Number(process.env.PORT || 8787)

createServer(async (req, res) => {
  const handler = routes[new URL(req.url, 'http://localhost').pathname]
  if (!handler) {
    res.statusCode = 404
    return res.end('not found')
  }
  try {
    await handler(req, res)
  } catch (error) {
    console.error(error)
    if (!res.headersSent) res.statusCode = 500
    res.end(JSON.stringify({ error: 'handler-threw' }))
  }
}).listen(port, () => {
  console.log(`trial api on http://127.0.0.1:${port}`)
  console.log(isPersistent ? 'store: upstash' : 'store: in-memory (dev only)')
})
