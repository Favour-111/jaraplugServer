import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'

const run = promisify(execFile)

/**
 * Generated placeholder "portraits": abstract silhouettes on a gradient. They are NOT photographs of anyone.
 * Replace with licensed photography (with documented model releases) before any real launch.
 */
export async function demoPortrait(hue: number, variant: number, label = 'DEMO'): Promise<Buffer> {
  const w = 800, h = 1000
  const cx = 400 + ((variant * 53) % 120) - 60
  const headY = 330 + ((variant * 37) % 60)
  const skin = `hsl(${(hue + 20) % 360} 28% ${16 + (variant % 3) * 3}%)`
  const rim = `hsl(${hue} 90% 55%)`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 70% ${14 + (variant % 4) * 3}%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 340) % 360} 60% 5%)"/>
    </linearGradient>
    <radialGradient id="glow" cx="${0.3 + (variant % 3) * 0.2}" cy="0.25" r="0.7">
      <stop offset="0" stop-color="${rim}" stop-opacity="0.45"/><stop offset="1" stop-color="${rim}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.65"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>
  <path d="M ${cx - 260} ${h} C ${cx - 250} ${headY + 330}, ${cx - 150} ${headY + 220}, ${cx} ${headY + 220} C ${cx + 150} ${headY + 220}, ${cx + 250} ${headY + 330}, ${cx + 260} ${h} Z" fill="${skin}"/>
  <rect x="${cx - 38}" y="${headY + 90}" width="76" height="140" rx="30" fill="${skin}"/>
  <ellipse cx="${cx}" cy="${headY}" rx="100" ry="125" fill="${skin}"/>
  <path d="M ${cx - 110} ${headY - 20} C ${cx - 120} ${headY - 170}, ${cx + 120} ${headY - 170}, ${cx + 110} ${headY - 20} C ${cx + 60} ${headY - 90}, ${cx - 60} ${headY - 90}, ${cx - 110} ${headY - 20} Z" fill="hsl(${hue} 30% 6%)"/>
  <path d="M ${cx + 98} ${headY - 60} C ${cx + 112} ${headY}, ${cx + 100} ${headY + 70}, ${cx + 60} ${headY + 112}" stroke="${rim}" stroke-opacity="0.55" stroke-width="3" fill="none"/>
  <rect width="${w}" height="${h}" fill="url(#fade)"/>
  <text x="24" y="${h - 24}" font-family="Helvetica, Arial, sans-serif" font-size="20" letter-spacing="4" fill="#fff" fill-opacity="0.35">${label}</text>
</svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer()
}

let cachedVideo: string | null = null
/** One small generated test clip, reused for every demo video. Needs ffmpeg; returns null if unavailable. */
export async function demoVideoFile(): Promise<string | null> {
  if (cachedVideo) return cachedVideo
  const out = path.join(os.tmpdir(), 'jaraplug-demo-video.mp4')
  try {
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'gradients=s=540x960:d=6:r=24:speed=0.03:c0=0x7a0019:c1=0x120004:c2=0xff1744', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { timeout: 60_000 })
  } catch {
    try {
      await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x5a0014:s=540x960:d=6:r=24', '-vf', 'hue=h=t*40', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { timeout: 60_000 })
    } catch {
      return null
    }
  }
  if (!fs.existsSync(out)) return null
  cachedVideo = out
  return out
}
