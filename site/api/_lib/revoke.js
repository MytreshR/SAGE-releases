import { get, set } from './store.js'
import { hoursForSerial } from './licence.js'

/**
 * Taking a key back when the money goes away.
 *
 * Keys were minted the moment payment succeeded and then never revisited, and
 * that is exactly the shape a stolen card wants: buy, activate within seconds,
 * spend the hours, and let the real cardholder dispute it three weeks later.
 * The charge reverses, the compute does not.
 *
 * Two things happen on a refund or a dispute:
 *
 *   1. The serial is marked revoked, so it can never be redeemed again - which
 *      matters most for a key that was bought and not yet used.
 *   2. Whatever hours it granted are taken back off the balance it was granted
 *      to, as far as they have not already been spent.
 *
 * The second half is deliberately not a clawback of spent time. If somebody
 * used four of five hours before the dispute landed, those four are gone and
 * pretending otherwise would leave a balance owing that nothing can collect.
 * What it does is stop the rest being usable, which is the part still worth
 * protecting.
 */

const revokedKey = (serial) => `sage:revoked:${serial}`

export const isRevoked = async (serial) => Boolean(await get(revokedKey(serial)))

/**
 * Marks a serial dead and claws back what is left of its grant.
 *
 * `deviceId` is where the key was actually redeemed, recorded by activate.js.
 * A key that was never redeemed has none, and only needs step one.
 */
export async function revokeSerial(serial, reason) {
  const already = await get(revokedKey(serial))
  if (already) return already

  const record = {
    serial,
    reason,
    revokedAt: new Date().toISOString(),
    clawedBackMs: 0,
    device: null
  }

  // Where was it redeemed? activate.js writes this when the key is used.
  const activation = await get(`sage:key:${serial}`)
  const deviceId = activation?.deviceId ?? null
  record.device = deviceId

  if (deviceId) {
    const licenceKey = `sage:licence:${deviceId}`
    const licence = await get(licenceKey)
    if (licence && licence.serials?.includes(serial)) {
      const grantedByThisKey = hoursForSerial(serial) * 60 * 60 * 1000
      const unspent = Math.max(0, (licence.grantedMs || 0) - (licence.usedMs || 0))

      // Only the unspent part can be taken. Time already used is gone, and
      // subtracting it anyway would leave a negative balance that follows the
      // person into any key they buy honestly afterwards.
      const clawback = Math.min(grantedByThisKey, unspent)
      licence.grantedMs = Math.max(0, (licence.grantedMs || 0) - clawback)
      licence.serials = licence.serials.filter((s) => s !== serial)
      await set(licenceKey, licence)

      record.clawedBackMs = clawback
    }
  }

  await set(revokedKey(serial), record)
  console.warn(
    `[revoke] serial ${serial} (${reason}) - clawed back ${Math.round(
      record.clawedBackMs / 60000
    )} min from ${deviceId ? deviceId.slice(0, 8) + '…' : 'no device'}`
  )
  return record
}
