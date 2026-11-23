import { createServer, request as upstreamRequest } from 'node:http'
import { pathToFileURL } from 'node:url'
import { timingSafeEqual } from 'node:crypto'

// prefix와 자산 인증 예외는 앞단 소유이며 jar의 고정 경로를 바꾸지 않는다.
export async function startProxy(backendUrl, token, port) {
  const backend = new URL(backendUrl)
  if (backend.protocol !== 'http:' || backend.hostname !== '127.0.0.1') throw new Error('로컬 HTTP backend만 허용합니다.')
  if (!token || /\s/.test(token)) throw new Error('예제 로그인 토큰이 필요합니다.')
  const expected = Buffer.from(`Bearer ${token}`)
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const ai = url.pathname.startsWith('/prefix/api/ai/')
    if (ai && !url.pathname.startsWith('/prefix/api/ai/assets/')) {
      const actual = Buffer.from(request.headers.authorization ?? '')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ message: '앞단 로그인 토큰이 필요합니다.' }))
        return
      }
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/internal/')) {
      response.writeHead(404); response.end(); return
    }
    const path = (ai ? url.pathname.slice('/prefix'.length) : url.pathname) + url.search
    const upstream = upstreamRequest(new URL(path, backend), { method: request.method, headers: { ...request.headers, host: backend.host } }, result => {
      response.writeHead(result.statusCode ?? 502, result.headers)
      result.pipe(response)
    })
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
    request.on('aborted', () => upstream.destroy())
    response.on('close', () => upstream.destroy())
    request.pipe(upstream)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startProxy(process.env.EXAMPLE_BACKEND_URL, process.env.EXAMPLE_LOGIN_TOKEN, Number(process.env.EXAMPLE_FRONT_PORT ?? '18083'))
  const stop = () => { server.close(); server.closeAllConnections() }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
