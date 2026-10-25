import { beforeEach, describe, expect, it } from 'vitest'
import { api, auth, makeClient, makeProvider, resetAll } from './helpers'

beforeEach(resetAll)

const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(400, 1)])

async function chat() {
  const c = await makeClient()
  const p = await makeProvider({ username: 'voice_pro' })
  const id = (await api().post('/api/conversations').set(auth(c)).send({ username: 'voice_pro' }).expect(200)).body.id as string
  return { c, p, id }
}

describe('voice notes', () => {
  it('accepts a recorded voice note, shows it in both lists and returns a playable url', async () => {
    const { c, p, id } = await chat()
    const r = await api().post(`/api/conversations/${id}/voice`).set(auth(c)).field('duration', '7').attach('file', webm(), 'note.webm').expect(201)
    expect(r.body).toMatchObject({ messageType: 'AUDIO', durationSeconds: 7 })
    expect(r.body.attachmentUrl).toBeTruthy()
    for (const u of [c, p]) {
      const list = (await api().get('/api/conversations').set(auth(u)).expect(200)).body.items
      expect(list[0].lastMessage.body).toBe('🎤 Voice message')
    }
    const hist = (await api().get(`/api/conversations/${id}/messages`).set(auth(p)).expect(200)).body.messages
    expect(hist[0].messageType).toBe('AUDIO')
  })

  it('rejects non-audio files and strangers', async () => {
    const { c, id } = await chat()
    await api().post(`/api/conversations/${id}/voice`).set(auth(c)).attach('file', Buffer.from('not audio '.repeat(50)), 'x.webm').expect(400)
    const stranger = await makeClient()
    await api().post(`/api/conversations/${id}/voice`).set(auth(stranger)).attach('file', webm(), 'note.webm').expect(404)
  })
})
