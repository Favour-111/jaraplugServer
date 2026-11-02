import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { uploadTmpDir } from '../storage'

const run = promisify(execFile)

/** Whether ffmpeg is on PATH (logged at startup: without it videos keep their original layout and get no poster). */
export async function hasFfmpeg(): Promise<boolean> {
  try { await run('ffmpeg', ['-version'], { timeout: 5_000 }); return true } catch { return false }
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
    await run('ffmpeg', ['-y', '-i', filePath, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', out], { timeout: 120_000 })
    return out
  } catch {
    await fs.promises.rm(out, { force: true }).catch(() => {})
    return null
  }
}

/** Best-effort poster frame + duration via ffmpeg/ffprobe. Returns nulls when ffmpeg is not installed. */
export async function probeVideo(filePath: string): Promise<{ poster: Buffer | null; durationSeconds: number | null }> {
  let durationSeconds: number | null = null
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath], { timeout: 20_000 })
    const d = parseFloat(stdout.trim())
    if (Number.isFinite(d)) durationSeconds = Math.round(d)
  } catch { /* ffprobe unavailable */ }
  const out = path.join(uploadTmpDir(), `${crypto.randomUUID()}.jpg`)
  try {
    const seek = durationSeconds && durationSeconds > 2 ? '1' : '0'
    await run('ffmpeg', ['-y', '-ss', seek, '-i', filePath, '-frames:v', '1', '-vf', 'scale=720:-2', out], { timeout: 60_000 })
    const poster = await fs.promises.readFile(out)
    return { poster, durationSeconds }
  } catch {
    return { poster: null, durationSeconds }
  } finally {
    fs.promises.rm(out, { force: true }).catch(() => {})
  }
}
