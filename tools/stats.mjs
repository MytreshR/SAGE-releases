/**
 * How SAGE is doing, as two spreadsheets.
 *
 *   node tools/stats.mjs
 *
 * Writes sage-summary-<date>.csv and sage-daily-<date>.csv next to the repo.
 * Both open in Excel by double-clicking.
 *
 * Two files rather than one on purpose. A summary is one row per metric and a
 * time series is one row per day; putting them in the same sheet gives you a
 * table where half the columns are blank on every row, and neither half can be
 * charted without being pulled apart again.
 *
 * Two sources, and only one of them needs a secret:
 *
 *   GitHub    download counts per release asset. Public, always available, and
 *             retrospective - it has been counting since the first release
 *             whether or not anyone was watching.
 *
 *   The site   /api/account/stats, behind SAGE_ADMIN_TOKEN. Trials, accounts,
 *             hours and sales, all read live out of the store.
 *
 * Runs without the token and reports downloads alone, which is better than
 * refusing to run at all - the number people usually want first is how many
 * copies went out.
 */

import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const REPO = 'MytreshR/SAGE-releases'
const SITE = process.env.SAGE_SITE || 'https://www.sagemeeting-ai.xyz'
const ADMIN = process.env.SAGE_ADMIN_TOKEN || ''

const today = new Date().toISOString().slice(0, 10)

/** Excel splits on commas and honours quotes; anything with either needs both. */
const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csv = (rows) => rows.map((r) => r.map(cell).join(',')).join('\n') + '\n'

// ---------------------------------------------------------------- downloads

function downloads() {
  // Through gh rather than fetch: it carries the user's existing auth, so this
  // works the same on a private repo without a token to manage here.
  const raw = execFileSync('gh', ['api', `repos/${REPO}/releases`, '--paginate'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })

  const releases = JSON.parse(raw)
  const perAsset = []
  let windows = 0
  let mac = 0

  for (const r of releases) {
    for (const a of r.assets) {
      // The installers people actually run. Blockmaps and update manifests are
      // downloaded by the updater on a schedule, so counting them would
      // measure how many copies are installed, not how many were taken.
      if (!/setup\.exe$|\.dmg$/.test(a.name)) continue
      const platform = a.name.endsWith('.dmg') ? 'macOS' : 'Windows'
      if (platform === 'macOS') mac += a.download_count
      else windows += a.download_count
      perAsset.push({
        tag: r.tag_name,
        published: r.published_at.slice(0, 10),
        platform,
        file: a.name,
        count: a.download_count
      })
    }
  }

  perAsset.sort((a, b) => b.published.localeCompare(a.published) || a.platform.localeCompare(b.platform))
  return { perAsset, windows, mac, total: windows + mac }
}

// -------------------------------------------------------------------- store

async function siteStats() {
  if (!ADMIN) return null
  const res = await fetch(`${SITE}/api/account/stats`, { headers: { 'x-sage-admin': ADMIN } })
  if (res.status === 404) {
    console.error('The site refused the admin token. Is SAGE_ADMIN_TOKEN set on Vercel, and the same value here?')
    return null
  }
  if (!res.ok) {
    console.error(`stats endpoint returned ${res.status}`)
    return null
  }
  return res.json()
}

// --------------------------------------------------------------------- main

const dl = downloads()
const site = await siteStats()

const money = (minor, currency) =>
  minor === undefined ? '' : `${(minor / 100).toFixed(2)} ${String(currency || 'usd').toUpperCase()}`

const summary = [
  ['Section', 'Metric', 'Value'],
  ['Downloads', 'Windows installers', dl.windows],
  ['Downloads', 'macOS disk images', dl.mac],
  ['Downloads', 'Total', dl.total]
]

if (site) {
  summary.push(
    ['Installs', 'Machines that have run SAGE', site.installs.machinesEverRun],
    ['Accounts', 'Accounts created', site.accounts.total],
    ['Accounts', 'Have ever bought hours', site.accounts.everBought],
    ['Accounts', 'Hold hours right now', site.accounts.withHoursNow],
    ['Accounts', 'Signed in on a computer', site.accounts.signedInOnADevice],
    ['Accounts', 'Active in the last 7 days', site.accounts.activeLast7Days],
    ['Accounts', 'Active in the last 30 days', site.accounts.activeLast30Days],
    ['Hours', 'Bought', site.hours.bought],
    ['Hours', 'Used', site.hours.used],
    ['Hours', 'Remaining on accounts', site.hours.remaining],
    ['Sales', 'Paid purchases', site.sales.count],
    ['Sales', 'Revenue', money(site.sales.revenueMinorUnits, site.sales.currency)],
    ['Sales', 'Test purchases (not counted above)', site.sales.testPurchases]
  )
} else {
  summary.push(['', '', ''], ['Note', 'Store figures unavailable', 'Set SAGE_ADMIN_TOKEN to include trials, accounts, hours and sales'])
}

summary.push(['', '', ''], ['Downloads by release', '', ''], ['Tag', 'Platform', 'Downloads'])
for (const a of dl.perAsset) summary.push([a.tag, a.platform, a.count])

const summaryFile = `sage-summary-${today}.csv`
writeFileSync(summaryFile, csv(summary))

// One row per day, so it can be charted without being taken apart first.
const daily = [['Date', 'New trials', 'Purchases']]
if (site) {
  const days = new Set([
    ...Object.keys(site.newTrialsByDay || {}),
    ...Object.keys(site.sales.byDay || {})
  ])
  for (const d of [...days].sort()) {
    daily.push([d, site.newTrialsByDay?.[d] ?? 0, site.sales.byDay?.[d] ?? 0])
  }
}

const dailyFile = `sage-daily-${today}.csv`
writeFileSync(dailyFile, csv(daily))

console.log(`\nWindows ${dl.windows}   macOS ${dl.mac}   total ${dl.total} downloads`)
if (site) {
  console.log(
    `Machines run ${site.installs.machinesEverRun}   accounts ${site.accounts.total}` +
      `   paid ${site.sales.count}   revenue ${money(site.sales.revenueMinorUnits, site.sales.currency)}`
  )
} else {
  console.log('Store figures skipped - SAGE_ADMIN_TOKEN is not set.')
}
console.log(`\nWrote ${summaryFile}`)
console.log(`Wrote ${dailyFile}${daily.length === 1 ? '  (empty without the admin token)' : ''}`)
