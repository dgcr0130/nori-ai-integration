import { expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startProxy } from '../../../examples/header-app/proxy.mjs'
import { object, text } from '../../src/api'

export interface ConsumerRequest { method: string; path: string; body: string; headers: IncomingHttpHeaders }
export class ConsumerApp {
  readonly requests: ConsumerRequest[] = []
  readonly internalResults: string[] = []
  readonly failures: Error[] = []
  readonly login = randomUUID()
  readonly service = randomUUID()
  readonly gatewayToken = randomUUID()
  base = ''
  origin = ''
  private directory = ''
  private child: ChildProcess | undefined
  private proxy: Server | undefined
  private gateway: Server | undefined
  private publicKey: ReturnType<typeof createPublicKey> | undefined
  private readonly job = randomUUID()

  constructor(readonly mode: 'cookie' | 'header') {}

  async start(): Promise<void> {
    this.directory = await mkdtemp(join(tmpdir(), 'nori-ai-consumer-'))
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    this.publicKey = pair.publicKey
    await Promise.all([
      writeFile(join(this.directory, 'actor'), JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: 'consumer', alg: 'ES256' })),
      writeFile(join(this.directory, 'service'), this.service),
      writeFile(join(this.directory, 'gateway'), this.gatewayToken),
      writeFile(join(this.directory, 'delegation'), randomBytes(32).toString('base64url')),
    ])
    this.gateway = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        const record = { method: request.method ?? 'GET', path: request.url ?? '/', body: Buffer.concat(chunks).toString('utf8'), headers: request.headers }
        this.requests.push(record)
        const claims = this.verifyAssertion(record)
        response.setHeader('Content-Type', 'application/json')
        if (record.path.startsWith('/v1/conversations') && record.method === 'GET') {
          response.end(JSON.stringify({ items: [], nextAfter: null })); return
        }
        if (record.path === '/v1/query' && record.method === 'POST') {
          expect(claims.dlg).toHaveLength(119)
          const internal = { version: '1', systemId: claims.sys, jobId: this.job, toolId: 'demo.record.read', subject: claims.sub,
            delegationId: claims.dlg, permissionDigest: claims.pdg, arguments: {}, targets: [], deadline: new Date(Date.now() + 10000).toISOString() }
          const result = await fetch(this.base + '/internal/ai/v1/query', { method: 'POST', headers: {
            Authorization: `Bearer ${this.gatewayToken}`, 'Content-Type': 'application/json', 'X-Request-Id': this.job,
            'X-Actor-Subject': text(claims.sub), 'X-Delegation-Id': text(claims.dlg),
          }, body: JSON.stringify(internal) })
          expect(result.status).toBe(200)
          const envelope = object(await result.json())
          expect(envelope.status).toBe('SUCCESS')
          this.internalResults.push(text(envelope.status))
          response.writeHead(202)
          response.end(JSON.stringify({ jobId: this.job, conversationId: 'conversation_1', messageId: 'message_1', queuePosition: 1 })); return
        }
        if (record.path === `/v1/analyses/${this.job}/events`) {
          response.setHeader('Content-Type', 'text/event-stream')
          response.end(`id: event_1\nevent: job.completed\ndata: {"jobId":"${this.job}","type":"job.completed"}\n\n`); return
        }
        if (record.path === `/v1/analyses/${this.job}`) {
          response.end(JSON.stringify({ jobId: this.job, jobStatus: 'SUCCEEDED', createdAt: new Date().toISOString(), terminalAt: new Date().toISOString(),
            result: { status: 'SUCCESS', errorCode: null, clarification: null, payload: { answer: {
              kind: 'ANSWER', text: '중립 예제 검증 답변', citations: [], sentences: [],
            }, blocks: [] } } })); return
        }
        response.writeHead(404); response.end()
      })().catch((error: unknown) => {
        this.failures.push(error instanceof Error ? error : new Error('Gateway 대역의 비표준 예외', { cause: error }))
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    })
    await new Promise<void>(resolve => this.gateway?.listen(0, '127.0.0.1', resolve))
    const address = this.gateway.address()
    if (!address || typeof address === 'string') throw new Error('Gateway 대역 주소 오류')
    const module = resolve(process.cwd(), `../examples/${this.mode}-app`)
    const child = spawn('java', ['-jar', join(module, `build/libs/${this.mode}-app-1.0.3.jar`), '--server.port=0'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        EXAMPLE_GATEWAY_URL: `http://127.0.0.1:${address.port}`, EXAMPLE_SERVICE_TOKEN_FILE: join(this.directory, 'service'),
        EXAMPLE_GATEWAY_TOKEN_FILE: join(this.directory, 'gateway'), EXAMPLE_ACTOR_JWK_FILE: join(this.directory, 'actor'),
        EXAMPLE_DELEGATION_KEY_FILE: join(this.directory, 'delegation'), EXAMPLE_LOGIN_PASSWORD: this.login, EXAMPLE_LOGIN_TOKEN: this.login,
      },
    })
    this.child = child
    this.base = await new Promise<string>((resolve, reject) => {
      let output = ''
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`예제 앱이 준비 전에 종료했습니다(exit ${code}).`)))
      child.stdout?.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).slice(-16384)
        const port = /Tomcat started on port (\d+)/.exec(output)?.[1]
        if (port) resolve(`http://127.0.0.1:${port}`)
      })
      child.stderr?.resume()
    })
    if (this.mode === 'header') {
      this.proxy = await startProxy(this.base, this.login, 0)
      const front = this.proxy.address()
      if (!front || typeof front === 'string') throw new Error('앞단 주소 오류')
      this.origin = `http://127.0.0.1:${front.port}`
    } else this.origin = this.base
  }

  private verifyAssertion(record: ConsumerRequest): Record<string, unknown> {
    expect(record.headers.authorization === `Bearer ${this.service}`).toBe(true)
    expect(record.headers.cookie).toBeUndefined()
    const assertion = record.headers['x-actor-assertion']
    if (typeof assertion !== 'string' || !this.publicKey) throw new Error('서명 헤더 누락')
    const [header, payload, signature] = assertion.split('.')
    if (!header || !payload || !signature) throw new Error('JWS 형식 오류')
    const parsed = object(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')))
    expect(parsed).toEqual({ kid: 'consumer', alg: 'ES256' })
    expect(verify('sha256', Buffer.from(`${header}.${payload}`), { key: this.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
    const claims = object(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    expect(claims.sys).toBe(this.mode === 'cookie' ? 'CookieExample' : 'HeaderExample')
    expect(claims.iss).toBe(`${this.mode}-example`)
    expect(claims.aud).toBe('ai-gateway')
    expect(claims.sub).toBe('reader_1')
    expect(claims.scope).toBe('READ')
    expect(claims.perm).toEqual(['DEMO_READ'])
    expect(Number(claims.exp) - Number(claims.iat)).toBe(60)
    return claims
  }

  async close(): Promise<void> {
    try {
      if (this.proxy) await closeServer(this.proxy)
    } finally {
      try {
        if (this.child?.pid && this.child.exitCode === null && this.child.signalCode === null) {
          const exited = new Promise<void>(resolve => this.child?.once('exit', () => resolve()))
          this.child.kill(); await exited
        }
      } finally {
        try { if (this.gateway) await closeServer(this.gateway) }
        finally { if (this.directory) await removeCredentials(this.directory) }
      }
    }
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
}

async function removeCredentials(directory: string): Promise<void> {
  const parent = resolve(tmpdir())
  if (!directory.startsWith(parent + '/') && !directory.startsWith(parent + '\\')) throw new Error('임시 자격 경로가 범위 밖입니다.')
  if (!directory.includes('nori-ai-consumer-') || (await lstat(directory)).isSymbolicLink()) throw new Error('임시 자격 소유 경로 오류')
  const names = await readdir(directory)
  if (names.some(name => !['actor', 'service', 'gateway', 'delegation'].includes(name))) throw new Error('임시 자격 디렉터리에 소유하지 않은 파일이 있습니다.')
  for (const name of names) if (!(await lstat(join(directory, name))).isFile()) throw new Error('임시 자격 파일 형식 오류')
  if (process.platform === 'win32') {
    const literal = directory.replaceAll("'", "''")
    const script = `$ErrorActionPreference='Stop'; $p='${literal}'; $all=@(Get-Item -LiteralPath $p -Force)+@(Get-ChildItem -LiteralPath $p -Recurse -Force); foreach($item in $all){if(($item.Attributes -band [IO.FileAttributes]'ReparsePoint,ReadOnly,Hidden,System') -ne 0){throw '임시 자격 보호 속성'}}; Remove-Item -LiteralPath $p -Recurse; if(Test-Path -LiteralPath $p){throw '임시 자격 잔여'}`
    await new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' })
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`임시 자격 정상 삭제 실패: ${directory}`)))
    })
  } else await rm(directory, { recursive: true })
  await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
}

export async function widgetDigest(): Promise<string> {
  return createHash('sha256').update(await readFile(resolve('dist/widget.js'))).digest('hex')
}
