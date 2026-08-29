/**
 * Sending email, over Resend's REST API, with no SDK.
 *
 * Same reasoning as the Stripe client: this API is plain ESM with no
 * dependencies and no build step, and one POST does not justify a package.
 *
 * Needs RESEND_API_KEY and SAGE_FROM_EMAIL, on a domain verified with Resend.
 * An unverified sender is accepted by the API and then silently dropped by the
 * receiving mail server, which looks exactly like the code never arriving.
 */

export const canSendEmail = () =>
  Boolean(process.env.RESEND_API_KEY && process.env.SAGE_FROM_EMAIL)

export async function send({ to, subject, text, html }) {
  if (!canSendEmail()) throw new Error('email is not configured')

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: process.env.SAGE_FROM_EMAIL, to: [to], subject, text, html })
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`resend ${res.status}: ${detail.slice(0, 200)}`)
  }
  return res.json().catch(() => ({}))
}

/**
 * The sign-in code.
 *
 * Plain text as well as HTML, because a login code that only renders in a
 * client with images and CSS enabled is a login code some people cannot read.
 * The code appears in the subject line too - it is the only thing in the
 * message that matters, and it saves opening the mail at all.
 */
export const sendLoginCode = (to, code) =>
  send({
    to,
    subject: `${code} is your SAGE sign-in code`,
    text: [
      `Your SAGE sign-in code is ${code}`,
      '',
      'It expires in 10 minutes and can be used once.',
      '',
      'If you did not ask to sign in, you can ignore this - somebody typed',
      'your address by mistake, and without this code nothing happens.'
    ].join('\n'),
    html: `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:420px">
        <p style="color:#444">Your SAGE sign-in code is</p>
        <p style="font-size:32px;font-weight:700;letter-spacing:.18em;margin:.4em 0">${code}</p>
        <p style="color:#666;font-size:14px">Expires in 10 minutes. Can be used once.</p>
        <p style="color:#888;font-size:13px;margin-top:2em">
          If you did not ask to sign in, ignore this — somebody typed your address
          by mistake, and without this code nothing happens.
        </p>
      </div>`
  })

/** The key, emailed as well as shown, because the success page gets closed. */
export const sendKey = (to, key, hours) =>
  send({
    to,
    subject: `Your SAGE key - ${hours} hours`,
    text: [
      `Here is your SAGE activation key:`,
      '',
      `    ${key}`,
      '',
      `It adds ${hours} hours of listening time.`,
      '',
      'Open SAGE, go to Settings, then App, then Activation, paste it in and',
      'press Activate. Hours stack if you buy another, and they do not expire.',
      '',
      'Keep this email - it is the only copy of the key we send you.'
    ].join('\n'),
    html: `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:460px">
        <p style="color:#444">Here is your SAGE activation key:</p>
        <p style="font-family:ui-monospace,monospace;font-size:20px;font-weight:600;
                  background:#f4f4f7;padding:14px 16px;border-radius:8px;letter-spacing:.04em">
          ${key}
        </p>
        <p style="color:#444">It adds <b>${hours} hours</b> of listening time.</p>
        <p style="color:#666;font-size:14px">
          Open SAGE → Settings → App → Activation, paste it in and press Activate.
          Hours stack if you buy another, and they do not expire.
        </p>
        <p style="color:#888;font-size:13px">Keep this email — it is the only copy we send.</p>
      </div>`
  })
