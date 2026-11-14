/**
 * Usage: npm run regen-video-thumbs -w server            (videos that never got a poster frame)
 *        npm run regen-video-thumbs -w server -- --all   (every video)
 *
 * Videos uploaded while the server had no ffmpeg got a plain dark placeholder instead of a poster frame (and no
 * duration), so their locked preview could not be blurred. This re-reads each video from storage, takes a frame,
 * and writes a fresh clear thumbnail plus its blurred copy.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'
import '../src/env'
import { prisma } from '../src/db'
import { storage, uploadTmpDir } from '../src/storage'
import { blurImage } from '../src/lib/upload'
import { hasFfmpeg, probeVideo } from '../src/lib/video'

async function main() {
  if (!(await hasFfmpeg())) throw new Error('ffmpeg is not available. Run `npm install` in server/ (ffmpeg-static) or set FFMPEG_PATH.')
  const all = process.argv.includes('--all')
  const videos = await prisma.mediaContent.findMany({
    where: { mediaType: 'VIDEO', storageKey: { not: 'deleted' }, ...(all ? {} : { durationSeconds: null }) },
    select: { id: true, providerId: true, storageKey: true, thumbnailKey: true, blurThumbKey: true },
  })
  console.log(`${videos.length} video(s) to process${all ? '' : ' (without a poster frame)'}.`)
  await fs.promises.mkdir(uploadTmpDir(), { recursive: true })
  let ok = 0
  for (const v of videos) {
    const tmp = path.join(uploadTmpDir(), `${crypto.randomUUID()}${path.extname(v.storageKey)}`)
    try {
      await storage.download(v.storageKey, tmp)
      const { poster, durationSeconds } = await probeVideo(tmp)
      if (!poster) { console.warn(`  ✖ ${v.id}: could not read a frame`); continue }
      const thumb = await sharp(poster).resize({ width: 480 }).jpeg({ quality: 70 }).toBuffer()
      const thumbKey = v.thumbnailKey ?? `thumbs/${v.providerId}/${v.id}.jpg`
      const blurKey = v.blurThumbKey ?? `thumbs/${v.providerId}/${v.id}.blur.jpg`
      await storage.putBuffer(thumbKey, thumb, 'image/jpeg')
      await storage.putBuffer(blurKey, await blurImage(thumb), 'image/jpeg')
      await prisma.mediaContent.update({ where: { id: v.id }, data: { thumbnailKey: thumbKey, blurThumbKey: blurKey, durationSeconds } })
      ok++
      console.log(`  ✔ ${v.id}`)
    } catch (e) {
      console.warn(`  ✖ ${v.id}:`, e instanceof Error ? e.message : e)
    } finally {
      await fs.promises.rm(tmp, { force: true }).catch(() => {})
    }
  }
  console.log(`Done: ${ok}/${videos.length} updated.`)
}
main().finally(() => prisma.$disconnect())
