import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { uploadTmpDir } from '../storage'

const run = promisify(execFile)

/**
 * ffmpeg binary. The npm package ffmpeg-static ships a binary for the server's platform, so
 * hosts without ffmpeg installed (e.g. Render) still get video posters, durations and fast-start. FFMPEG_PATH
 * overrides it; a plain "ffmpeg" on PATH is the last resort.
 */
function binary(envVar: string, pkg: string, fallback: string): string {
  if (process.env[envVar]) return process.env[envVar]!
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(pkg) as string | { path?: string } | null
    const p = typeof mod === 'string' ? mod : mod?.path
    if (p && fs.existsSync(p)) return p
  } catch { /* package not installed */ }
  return fallback
}
export const FFMPEG = binary('FFMPEG_PATH', 'ffmpeg-static', 'ffmpeg')
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe' // optional; durations fall back to ffmpeg's own output

/** Whether ffmpeg is on PATH (logged at startup: without it videos keep their original layout and get no poster). */
export async function hasFfmpeg(): Promise<boolean> {
  try { await run(FFMPEG, ['-version'], { timeout: 5_000 }); return true } catch { return false }
}

/**
 * Best-effort "fast start" for MP4/MOV: rewrites the file with its index (moov atom) at the front, without re-encoding.
 * Phones often write the index at the END, so a browser has to fetch the tail of a large file before it can show a
 * single frame. Returns the new file's path, or null if ffmpeg is unavailable or the remux failed (keep the original).
 */
export async function faststart(filePath: string, ext: string): Promise<string | null> {
  if (ext !== 'mp4' && ext !== 'mov') return null
  const out = path.join(uploadTmpDir(), `${crypto.randomUUID()}.${ext}`)
  try {
    await run(FFMPEG, ['-y', '-i', filePath, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', out], { timeout: 120_000 })
    return out
  } catch {
    await fs.promises.rm(out, { force: true }).catch(() => {})
    return null
  }
}

/** Best-effort poster frame + duration via ffmpeg (ffprobe if installed). Returns nulls when ffmpeg is not available. */
export async function probeVideo(filePath: string): Promise<{ poster: Buffer | null; durationSeconds: number | null }> {
  let durationSeconds: number | null = null
  try {
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath], { timeout: 20_000 })
    const d = parseFloat(stdout.trim())
    if (Number.isFinite(d)) durationSeconds = Math.round(d)
  } catch { /* ffprobe unavailable: ffmpeg's own report below */ }
  if (durationSeconds === null) {
    // `ffmpeg -i file` with no output exits with an error but prints "Duration: HH:MM:SS.xx" on stderr.
    const stderr = await run(FFMPEG, ['-hide_banner', '-i', filePath], { timeout: 20_000 }).then((r) => r.stderr, (e: { stderr?: string }) => e.stderr ?? '')
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
    if (m) durationSeconds = Math.round(+m[1] * 3600 + +m[2] * 60 + +m[3])
  }
  const out = path.join(uploadTmpDir(), `${crypto.randomUUID()}.jpg`)
  try {
    const seek = durationSeconds && durationSeconds > 2 ? '1' : '0'
    await run(FFMPEG, ['-y', '-ss', seek, '-i', filePath, '-frames:v', '1', '-vf', 'scale=720:-2', out], { timeout: 60_000 })
    const poster = await fs.promises.readFile(out)
    return { poster, durationSeconds }
  } catch {
    return { poster: null, durationSeconds }
  } finally {
    fs.promises.rm(out, { force: true }).catch(() => {})
  }
}
