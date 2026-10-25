import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'
import multer from 'multer'
import { Prisma } from '@prisma/client'

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message)
  }
}
export const badRequest = (m: string, code?: string) => new HttpError(400, m, code)
export const unauthorized = (m = 'Authentication required') => new HttpError(401, m, 'UNAUTHENTICATED')
export const forbidden = (m = 'You do not have permission to do that', code = 'FORBIDDEN') => new HttpError(403, m, code)
export const notFound = (m = 'Not found') => new HttpError(404, m, 'NOT_FOUND')
export const conflict = (m: string, code = 'CONFLICT') => new HttpError(409, m, code)

/** Wrap async route handlers so rejected promises reach the error handler. */
export const wrap =
  (fn: (...args: Parameters<RequestHandler>) => Promise<unknown> | unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code })
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE'
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'File is too large' : err.message, code: err.code })
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return res.status(409).json({ error: 'That value is already taken', code: 'UNIQUE' })
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' })
  console.error('Unhandled error:', err)
  res.status(500).json({ error: 'Something went wrong' })
}
