import nodemailer from 'nodemailer'
import { env } from '../env'
import { HttpError } from '../lib/errors'

export type Mail = { to: string; subject: string; text: string }

/** Emails "sent" while running the test-suite, so tests can read codes. */
export const outbox: Mail[] = []

const transport = env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS
  ? nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } })
  : null

export async function sendMail(m: Mail) {
  if (env.NODE_ENV === 'test') { outbox.push(m); return }
  if (!transport) {
    if (env.NODE_ENV === 'production') throw new HttpError(503, 'Email is not configured', 'EMAIL_NOT_CONFIGURED')
    // Local development without SMTP: print the email so the flow can still be tested.
    console.log(`\n✉  [dev] SMTP not configured — would email ${m.to}\n   Subject: ${m.subject}\n${m.text.split('\n').map((l) => '   ' + l).join('\n')}\n`)
    return
  }
  await transport.sendMail({ from: env.MAIL_FROM ?? env.SMTP_USER, to: m.to, subject: m.subject, text: m.text })
}

/** For notifications where a mail failure must never break the request that triggered it. */
export const sendMailQuietly = (m: Mail) => sendMail(m).catch((e) => console.error('Email failed:', m.subject, e instanceof Error ? e.message : e))
