import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { uploadTmpDir } from '../storage'

const run = promisify(execFile)

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
