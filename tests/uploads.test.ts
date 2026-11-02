import { beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import { api, auth, makeProvider, png, prisma, resetAll } from './helpers'
import { resolveLocalPath } from '../src/storage'

beforeEach(resetAll)

const ticketFor = async (u: any) => (await api().post('/api/me/upload-ticket').set(auth(u)).expect(200)).body.ticket as string
const uploadPhoto = (headers: Record<string, string>) =>
  api().post('/api/content').set(headers).field('title', 'Pic').field('visibility', 'PUBLIC').attach('file', fs.readFileSync(pngPath), { filename: 'a.png', contentType: 'image/png' })
let pngPath = ''

describe('upload tickets (slow uploads outliving the session token)', () => {
  beforeEach(async () => {
    pngPath = path.join(os.tmpdir(), `jp-upload-${process.pid}.png`)
    fs.writeFileSync(pngPath, await png())
  })

  it('accepts a multipart upload whose session token has expired when it carries a valid ticket', async () => {
    const p = await makeProvider({ username: 'amara' })
    const ticket = await ticketFor(p)
    await uploadPhoto({ Authorization: 'Bearer expired.or.garbage', 'X-Upload-Ticket': ticket }).expect(201)
    await uploadPhoto({ 'X-Upload-Ticket': ticket }).expect(201)
    expect(await prisma.mediaContent.count({ where: { providerId: p.id } })).toBe(2)
  })

  it('only works on multipart requests, and rejects forged tickets', async () => {
    const p = await makeProvider({ username: 'amara' })
    const ticket = await ticketFor(p)
    await api().get('/api/me').set('X-Upload-Ticket', ticket).expect(401)
    await api().patch('/api/me').set('X-Upload-Ticket', ticket).send({ displayName: 'Hacked' }).expect(401)
    const forged = jwt.sign({ sub: p.authProviderId, purpose: 'upload' }, 'some-other-secret')
    await uploadPhoto({ 'X-Upload-Ticket': forged }).expect(401)
    await uploadPhoto({ 'X-Upload-Ticket': jwt.sign({ sub: p.authProviderId, purpose: 'upload' }, 'x', { expiresIn: -10 }) }).expect(401)
  })
})

/** Offsets of the top-level MP4 boxes we care about. */
const boxOffsets = (buf: Buffer) => {
  const at: Record<string, number> = {}
  for (let i = 0; i + 8 <= buf.length;) {
    let size = buf.readUInt32BE(i)
    const type = buf.toString('ascii', i + 4, i + 8)
    if (size === 1) size = Number(buf.readBigUInt64BE(i + 8))
    at[type] ??= i
    if (size < 8) break
    i += size
  }
  return at
}

const ffmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()

describe('video uploads', () => {
  it.runIf(ffmpeg)('are rewritten so playback can start before the whole file downloads', async () => {
    const src = path.join(os.tmpdir(), `jp-slowstart-${process.pid}.mp4`)
    // ffmpeg writes the index (moov) at the END by default, like many phones.
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15', '-c:v', 'mpeg4', src])
    const before = boxOffsets(fs.readFileSync(src))
    expect(before.moov).toBeGreaterThan(before.mdat)

    const p = await makeProvider({ username: 'amara' })
    const r = await api().post('/api/content').set(auth(p)).field('title', 'Clip').field('visibility', 'PUBLIC')
      .attach('file', fs.readFileSync(src), { filename: 'clip.mp4', contentType: 'video/mp4' }).expect(201)
    const row = await prisma.mediaContent.findUniqueOrThrow({ where: { id: r.body.id } })
    const stored = fs.readFileSync(resolveLocalPath(row.storageKey))
    const after = boxOffsets(stored)
    expect(after.moov).toBeLessThan(after.mdat)
    expect(row.sizeBytes).toBe(stored.length)
    expect(row.durationSeconds).toBe(2)
  })
})
