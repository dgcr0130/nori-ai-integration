import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { startProxy } from './proxy.mjs'

test('앞단은 자산만 무인증으로 전달하고 prefix·토큰·본문을 보존한다', async () => {
  const recorded = []
  const token = randomUUID()
  const widget = Buffer.from('customElements.get("nori-ai-widget")')
  const backend = createServer((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      recorded.push({ path: request.url, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() })
      response.setHeader('Content-Type', request.url.includes('/assets/') ? 'application/javascript' : 'application/json')
      response.end(request.url.includes('/assets/') ? widget : JSON.stringify({ csrf: null }))
    })().catch(error => response.destroy(error))
  })
  let proxy
  try {
    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
    proxy = await startProxy(`http://127.0.0.1:${backend.address().port}`, token, 0)
    const origin = `http://127.0.0.1:${proxy.address().port}`
    const asset = await fetch(origin + '/prefix/api/ai/assets/widget.js')
    assert.equal(asset.status, 200)
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), widget)
    assert.deepEqual(recorded, [{ path: '/api/ai/assets/widget.js', authorization: undefined, body: '' }])
    assert.equal((await fetch(origin + '/prefix/api/ai/session')).status, 401)
    assert.equal((await fetch(origin + '/prefix/api/ai/session', { headers: { Authorization: 'Bearer invalid' } })).status, 401)
    assert.equal((await fetch(origin + '/api/ai/session', { headers: { Authorization: `Bearer ${token}` } })).status, 404)
    assert.equal((await fetch(origin + '/internal/ai/v1/query')).status, 404)
    assert.equal(recorded.length, 1)
    const result = await fetch(origin + '/prefix/api/ai/v1/query?cursor=opaque', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"query":"중립 질문"}' })
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), { csrf: null })
    assert.equal(recorded.length, 2)
    assert.equal(recorded[1].path, '/api/ai/v1/query?cursor=opaque')
    assert.equal(recorded[1].authorization === `Bearer ${token}`, true)
    assert.equal(recorded[1].body, '{"query":"중립 질문"}')
  } finally {
    if (proxy) await close(proxy)
    await close(backend)
  }
})

async function close(server) {
  await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
}
