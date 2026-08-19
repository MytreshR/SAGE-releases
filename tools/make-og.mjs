/**
 * Renders site/og.png, the 1200x630 card that appears when the site is shared
 * on LinkedIn, X, Slack or WhatsApp.
 *
 * Same approach as the app icon: signed distance fields and zlib, no image
 * library. A link preview is often the only thing a person sees before
 * deciding whether to click, so it is worth more than a default blank card.
 *
 *   node tools/make-og.mjs
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const W = 1200
const H = 630

// Matches the site palette exactly
const BG = [7, 7, 12]
const GLOW_A = [99, 102, 241]
const GLOW_B = [168, 85, 247]
const BAR_TOP = [129, 140, 248]
const BAR_BOT = [192, 132, 252]

const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

/** Distance to a vertical capsule, in pixels. */
function capsule(px, py, cx, y0, y1, r) {
  const dy = py - Math.min(Math.max(py, y0), y1)
  return Math.hypot(px - cx, dy) - r
}

// The same five-bar waveform as the icon, scaled up and set left of centre
const BARS = [
  { h: 0.30 },
  { h: 0.52 },
  { h: 0.72 },
  { h: 0.52 },
  { h: 0.30 }
]
const UNIT = 190 // notional icon edge length in px
const BAR_W = 0.088 * UNIT
const GAP = 0.054 * UNIT
const SPAN = BARS.length * BAR_W + (BARS.length - 1) * GAP
const MARK_X = 96
const MARK_CY = H / 2 - 40

const px = Buffer.alloc(W * H * 4)

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    // Two soft radial glows, mirroring the page background
    const d1 = Math.hypot(x - W * 0.14, y + H * 0.12) / (W * 0.62)
    const d2 = Math.hypot(x - W * 0.92, y - H * 0.1) / (W * 0.6)
    const g1 = Math.max(0, 1 - d1) ** 2 * 0.5
    const g2 = Math.max(0, 1 - d2) ** 2 * 0.38

    let r = BG[0] + GLOW_A[0] * g1 + GLOW_B[0] * g2
    let g = BG[1] + GLOW_A[1] * g1 + GLOW_B[1] * g2
    let b = BG[2] + GLOW_A[2] * g1 + GLOW_B[2] * g2

    // Waveform mark
    let d = Infinity
    let cx = MARK_X + BAR_W / 2
    for (const bar of BARS) {
      const half = (bar.h * UNIT) / 2 - BAR_W / 2
      d = Math.min(d, capsule(x, y, cx, MARK_CY - half, MARK_CY + half, BAR_W / 2))
      cx += BAR_W + GAP
    }
    const cov = 1 - smoothstep(-1, 1, d)
    if (cov > 0) {
      // Vertical gradient across the mark
      const t = Math.min(Math.max((y - (MARK_CY - UNIT / 2)) / UNIT, 0), 1)
      const br = BAR_TOP[0] + (BAR_BOT[0] - BAR_TOP[0]) * t
      const bg = BAR_TOP[1] + (BAR_BOT[1] - BAR_TOP[1]) * t
      const bb = BAR_TOP[2] + (BAR_BOT[2] - BAR_TOP[2]) * t
      r += (br - r) * cov
      g += (bg - g) * cov
      b += (bb - b) * cov
    }

    const i = (y * W + x) * 4
    px[i] = Math.min(255, Math.round(r))
    px[i + 1] = Math.min(255, Math.round(g))
    px[i + 2] = Math.min(255, Math.round(b))
    px[i + 3] = 255
  }
}

// --- 5x7 bitmap font, enough for the two lines of text on the card ---------
const GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
}

/** Draws a word from the bitmap font at a given scale. */
function drawWord(word, x0, y0, scale, colour) {
  // Buffer indices must be integers: px[1234.5] = n is silently discarded, so a
  // fractional origin drew nothing at all and raised no error.
  let cursor = Math.round(x0)
  y0 = Math.round(y0)
  for (const ch of word) {
    const rows = GLYPHS[ch]
    if (!rows) {
      cursor += 6 * scale
      continue
    }
    for (let ry = 0; ry < rows.length; ry++) {
      for (let rx = 0; rx < rows[ry].length; rx++) {
        if (rows[ry][rx] !== '1') continue
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = cursor + rx * scale + dx
            const y = y0 + ry * scale + dy
            if (x < 0 || x >= W || y < 0 || y >= H) continue
            const i = (y * W + x) * 4
            px[i] = colour[0]
            px[i + 1] = colour[1]
            px[i + 2] = colour[2]
          }
        }
      }
    }
    cursor += 6 * scale
  }
}

drawWord('SAGE', MARK_X + SPAN + 70, MARK_CY - 52, 18, [237, 236, 245])

// --- PNG encoding ----------------------------------------------------------
const CRC = (() => {
  const tbl = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    tbl[n] = c
  }
  return tbl
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8
ihdr[9] = 6

const raw = Buffer.alloc(H * (W * 4 + 1))
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

writeFileSync(resolve(ROOT, 'site/og.png'), png)
console.log(`site/og.png  ${W}x${H}  ${(png.length / 1024).toFixed(0)} KB`)
