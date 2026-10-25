import fs from 'node:fs'

export type SniffedType = { mime: string; ext: string; kind: 'IMAGE' | 'VIDEO' }

/** Identify a file by its magic bytes — never trust the client-supplied mimetype or extension. */
export async function sniffFile(filePath: string): Promise<SniffedType | null> {
  const fh = await fs.promises.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(32)
    await fh.read(buf, 0, 32, 0)
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', kind: 'IMAGE' }
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png', kind: 'IMAGE' }
    if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp', kind: 'IMAGE' }
    if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
      const brand = buf.subarray(8, 12).toString('ascii')
      if (brand.startsWith('qt')) return { mime: 'video/quicktime', ext: 'mov', kind: 'VIDEO' }
      return { mime: 'video/mp4', ext: 'mp4', kind: 'VIDEO' }
    }
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { mime: 'video/webm', ext: 'webm', kind: 'VIDEO' }
    return null
  } finally {
    await fh.close()
  }
}

export type SniffedAudio = { mime: string; ext: string }

/** Voice notes recorded in the browser: WebM/Opus (Chrome, Edge, Firefox), Ogg/Opus (Firefox) or MP4/AAC (Safari). Verified by magic bytes. */
export async function sniffAudioFile(filePath: string): Promise<SniffedAudio | null> {
  const fh = await fs.promises.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(16)
    await fh.read(buf, 0, 16, 0)
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { mime: 'audio/webm', ext: 'weba' }
    if (buf.subarray(0, 4).toString('ascii') === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' }
    if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return { mime: 'audio/mp4', ext: 'm4a' }
    return null
  } finally {
    await fh.close()
  }
}
