import fs from 'node:fs'
import multer from 'multer'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { env } from '../env'
import { badRequest } from './errors'
import { sniffAudioFile, sniffFile, type SniffedAudio, type SniffedType } from './sniff'
import { uploadTmpDir } from '../storage'

fs.mkdirSync(uploadTmpDir(), { recursive: true })

const disk = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadTmpDir()),
  filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
})

/** Content uploads (photos up to MAX_VIDEO_MB for video). Type is verified by magic bytes after upload. */
export const contentUpload = multer({
  storage: disk,
  limits: { fileSize: env.MAX_VIDEO_MB * 1024 * 1024, files: 1, fields: 20 },
})
export const imageUpload = multer({
  storage: disk,
  limits: { fileSize: env.MAX_IMAGE_MB * 1024 * 1024, files: 1, fields: 5 },
})

export const VOICE_NOTE_MAX_MB = 5
export const VOICE_NOTE_MAX_SECONDS = 300
export const voiceUpload = multer({
  storage: disk,
  limits: { fileSize: VOICE_NOTE_MAX_MB * 1024 * 1024, files: 1, fields: 5 },
})

export const rm = (p?: string) => (p ? fs.promises.rm(p, { force: true }).catch(() => {}) : Promise.resolve())

/** Validates the uploaded temp file's real type and size limits. Deletes it and throws on failure. */
export async function validateUpload(file: Express.Multer.File | undefined, allow: Array<'IMAGE' | 'VIDEO'>): Promise<SniffedType> {
  if (!file) throw badRequest('A file is required', 'FILE_REQUIRED')
  const sniffed = await sniffFile(file.path)
  if (!sniffed || !allow.includes(sniffed.kind)) {
    await rm(file.path)
    throw badRequest(`Unsupported file type. Allowed: ${allow.includes('VIDEO') ? 'JPG, PNG, WebP, MP4, MOV, WebM' : 'JPG, PNG, WebP'}`, 'BAD_FILE_TYPE')
  }
  const maxMb = sniffed.kind === 'IMAGE' ? env.MAX_IMAGE_MB : env.MAX_VIDEO_MB
  if (file.size > maxMb * 1024 * 1024) {
    await rm(file.path)
    throw badRequest(`${sniffed.kind === 'IMAGE' ? 'Images' : 'Videos'} must be under ${maxMb}MB`, 'FILE_TOO_LARGE')
  }
  return sniffed
}

/** Re-encodes an image (strips EXIF/GPS metadata) and returns main + thumbnail buffers. */
/**
 * Heavy blur baked into the pixels: shrink to 24px wide (destroying detail), blur, then scale back up.
 * The result cannot be "un-blurred" because the detail is gone, unlike a CSS blur on the real image.
 */
export async function blurImage(input: Buffer) {
  // Two separate pipelines: sharp only honours the LAST resize() in a chain, so shrink-then-enlarge in one chain
  // silently skips the shrink and leaves the picture almost sharp.
  const { data, info } = await sharp(input).rotate().resize({ width: 24 }).raw().toBuffer({ resolveWithObject: true })
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .resize({ width: 480, kernel: 'cubic' }).blur(6).modulate({ brightness: 0.85 }).jpeg({ quality: 70 }).toBuffer()
}

export async function processImage(filePath: string | Buffer, opts: { maxWidth?: number } = {}) {
  const main = await sharp(filePath).rotate().resize({ width: opts.maxWidth ?? 1600, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
  const thumbBase = sharp(filePath).rotate().resize({ width: 480, withoutEnlargement: true })
  // Clear thumbnail. Locked viewers get blurImage()'s copy instead (see services/content.ts blurredThumbKey).
  const thumb = await thumbBase.jpeg({ quality: 70 }).toBuffer()
  return { main, thumb }
}

/** Validates a recorded voice note by its real type. Deletes the temp file and throws on failure. */
export async function validateVoiceNote(file: Express.Multer.File | undefined): Promise<SniffedAudio> {
  if (!file) throw badRequest('A recording is required', 'FILE_REQUIRED')
  const sniffed = await sniffAudioFile(file.path)
  if (!sniffed || file.size < 200) {
    await rm(file.path)
    throw badRequest('Unsupported or empty recording', 'BAD_FILE_TYPE')
  }
  return sniffed
}
