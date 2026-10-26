import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { env } from '../env'

/**
 * Private object storage. Objects are NEVER publicly addressable: every read goes through a
 * short-lived signed URL that is only minted after a server-side entitlement check.
 */
export interface Storage {
  putFile(key: string, localPath: string, contentType: string): Promise<void>
  putBuffer(key: string, data: Buffer, contentType: string): Promise<void>
  delete(key: string): Promise<void>
  signedUrl(key: string, ttlSeconds?: number): Promise<string>
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url')
const hmac = (payload: string) => crypto.createHmac('sha256', env.MEDIA_SIGNING_SECRET).update(payload).digest('base64url')

export function verifyMediaToken(token: string): string | null {
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = hmac(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const { k, e } = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (typeof k !== 'string' || typeof e !== 'number' || e < Date.now() / 1000) return null
    return k
  } catch {
    return null
  }
}

export const localRoot = () => path.resolve(process.cwd(), env.LOCAL_STORAGE_DIR, 'private')

export function resolveLocalPath(key: string): string {
  const root = localRoot()
  const full = path.resolve(root, key)
  if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key')
  return full
}

class LocalStorage implements Storage {
  async putFile(key: string, localPath: string) {
    const dest = resolveLocalPath(key)
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    await fs.promises.copyFile(localPath, dest)
  }
  async putBuffer(key: string, data: Buffer) {
    const dest = resolveLocalPath(key)
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    await fs.promises.writeFile(dest, data)
  }
  async delete(key: string) {
    await fs.promises.rm(resolveLocalPath(key), { force: true })
  }
  async signedUrl(key: string, ttl = env.MEDIA_URL_TTL_SECONDS) {
    const payload = b64(JSON.stringify({ k: key, e: Math.floor(Date.now() / 1000) + ttl }))
    return `${env.API_BASE_URL}/api/media/f/${payload}.${hmac(payload)}`
  }
}

/** S3-compatible private bucket (production). Not exercised by the automated tests — verify against your bucket before launch. */
class S3Storage implements Storage {
  private clientPromise = (async () => {
    const { S3Client } = await import('@aws-sdk/client-s3')
    return new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
    })
  })()
  async putFile(key: string, localPath: string, contentType: string) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    await (await this.clientPromise).send(
      new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: fs.createReadStream(localPath), ContentType: contentType }),
    )
  }
  async putBuffer(key: string, data: Buffer, contentType: string) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    await (await this.clientPromise).send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: data, ContentType: contentType }))
  }
  async delete(key: string) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    await (await this.clientPromise).send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
  }
  async signedUrl(key: string, ttl = env.MEDIA_URL_TTL_SECONDS) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3')
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
    return getSignedUrl(await this.clientPromise, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { expiresIn: ttl })
  }
}

export const storage: Storage = env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage()

export const uploadTmpDir = () => path.resolve(process.cwd(), env.LOCAL_STORAGE_DIR, 'tmp')

/** Startup sanity check for the S3 settings: says plainly what to fix instead of failing later with a 500 on upload. */
export async function checkStorageConfig() {
  if (env.STORAGE_DRIVER !== 's3') return
  try {
    if (env.S3_ENDPOINT) console.warn(`⚠  S3_ENDPOINT is set (${env.S3_ENDPOINT}). For AWS S3 leave it empty; a wrong endpoint causes PermanentRedirect errors.`)
    // Any request to a bucket answers with its real region in a header, even when access is denied.
    const res = await fetch(`https://${env.S3_BUCKET}.s3.amazonaws.com`, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
    const real = res.headers.get('x-amz-bucket-region')
    if (!real) console.warn(`⚠  S3 bucket "${env.S3_BUCKET}" was not found (HTTP ${res.status}). Check S3_BUCKET for typos or spaces.`)
    else if (real !== env.S3_REGION) console.warn(`⚠  S3_REGION is "${env.S3_REGION}" but bucket "${env.S3_BUCKET}" is in "${real}". Set S3_REGION=${real} or uploads will fail.`)
    else console.log(`✔ S3 bucket "${env.S3_BUCKET}" found in ${real}`)
  } catch (e) {
    console.warn('⚠  Could not check the S3 bucket:', e instanceof Error ? e.message : e)
  }
}
