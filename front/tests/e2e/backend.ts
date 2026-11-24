import { test as base, expect, type Page, type BrowserContext } from '@playwright/test'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { createHash } from 'node:crypto'
import type { ReviewDetail, ReviewStatus } from '../../src/review'

interface Conversation { id: string; title: string | null; createdAt: string; updatedAt: string; status: string }
interface Message { messageId: string; role: string; content: string | Record<string, unknown> }
interface SavedConversation { subject: string; value: Conversation; messages: Message[] }
interface Accepted { jobId: string; conversationId: string; messageId: string; queuePosition: number }
interface Job { subject: string; accepted: Accepted; active: boolean; status: string }
export interface RecordedRequest { method: string; path: string; headers: IncomingHttpHeaders; body: string; subject: string | null }
interface Override { method: string; path: RegExp; status: number; body?: unknown; hold?: boolean; afterAdmission?: boolean; retryAfter?: string }
export interface TestEvent { id: string; event: string; data: Record<string, unknown> }

let hostBundle: Promise<string> | undefined
function bundleHost(): Promise<string> {
  hostBundle ??= (async () => {
    const output = await build({
      configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: { write: false, lib: { entry: fileURLToPath(new URL('./host-react.ts', import.meta.url)), formats: ['iife'], name: 'TestHost' } },
    })
    const bundles = Array.isArray(output) ? output : [output]
    for (const bundle of bundles) {
      if ('output' in bundle) for (const entry of bundle.output) if (entry.type === 'chunk') return entry.code
    }
    throw new Error('호스트 React 번들을 찾을 수 없습니다.')
  })()
  return hostBundle
}

export class TestBackend {
  origin = ''
  readonly requests: RecordedRequest[] = []
  readonly errors: string[] = []
  readonly conversations = new Map<string, SavedConversation>()
  readonly jobs = new Map<string, Job>()
  readonly streams = new Map<string, Set<ServerResponse>>()
  readonly overrides: Override[] = []
  readonly replay = new Map<string, TestEvent[]>()
  readonly pendingResponses = new Set<ServerResponse>()
  readonly issuedCursors: string[] = []
  readonly reviewers = new Set<string>()
  readonly feedbacks = new Map<string, { subject: string; detail: ReviewDetail }>()
  readonly reviewCursors: string[] = []
  private readonly reviewPositions = new Map<string, number>()
  private readonly keys = new Map<string, { digest: string; accepted: Accepted }>()
  private readonly server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const header = request.headers.authorization
      const cookie = /(?:^|;\s*)sid=([^;]+)/.exec(request.headers.cookie ?? '')?.[1]
      const subject = header?.startsWith('Bearer ') ? header.slice(7) : cookie ?? null
      const record = { method: request.method ?? 'GET', path: request.url ?? '/', headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'), subject }
      this.requests.push(record)
      await this.handle(record, response)
    })().catch(error => {
      this.errors.push(error instanceof Error ? error.message : String(error))
      if (!response.headersSent) this.json(response, 500, { message: '대역 처리 실패' })
      else response.destroy()
    })
  })
  private widget = ''
  private host = ''
  private serial = 0

  async start(): Promise<void> {
    ;[this.widget, this.host] = await Promise.all([
      readFile(new URL('../../dist/widget.js', import.meta.url), 'utf8'), bundleHost(),
    ])
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve() })
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('대역 주소를 확인할 수 없습니다.')
    this.origin = `http://127.0.0.1:${address.port}`
  }
  async close(): Promise<void> {
    if (!this.server.listening) return
    for (const connections of this.streams.values()) for (const response of connections) response.end()
    for (const response of this.pendingResponses) response.end()
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve())
      this.server.closeAllConnections()
    })
  }
  get openStreams(): number { return [...this.streams.values()].reduce((sum, connections) => sum + connections.size, 0) }
  get apiRequests(): RecordedRequest[] { return this.requests.filter(entry => /\/(session|v1\/)/.test(entry.path)) }
  seed(subject: string, title: string | null = null): string {
    const id = `conversation-${++this.serial}`
    const now = new Date().toISOString()
    this.conversations.set(id, { subject, value: { id, title, createdAt: now, updatedAt: now, status: 'ACTIVE' }, messages: [] })
    return id
  }
  failNext(override: Override): void { this.overrides.push(override) }
  event(jobId: string, event: string, id: string, extra: Record<string, unknown> = {}): void {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('Job이 없습니다.')
    if (event === 'job.started') job.status = 'RUNNING'
    const terminal = ['job.completed', 'job.partial', 'job.failed', 'job.cancelled'].includes(event)
    if (terminal) {
      job.active = false
      job.status = event === 'job.completed' ? 'SUCCEEDED' : event === 'job.partial' ? 'PARTIAL' : event === 'job.cancelled' ? 'CANCELLED' : 'FAILED'
      const conversation = this.conversations.get(job.accepted.conversationId)
      if (job.status === 'SUCCEEDED' || job.status === 'PARTIAL') {
        conversation?.messages.push({ messageId: `answer-${jobId}`, role: 'assistant', content: this.result(jobId) })
      }
    }
    const value = { id, event, data: { type: event, jobId, ...extra } }
    const events = this.replay.get(jobId) ?? []
    events.push(value); this.replay.set(jobId, events)
    for (const response of this.streams.get(jobId) ?? []) {
      this.writeEvent(response, value)
      if (terminal) response.end()
    }
  }
  interrupt(jobId: string): void { for (const response of this.streams.get(jobId) ?? []) response.end() }
  private writeEvent(response: ServerResponse, event: TestEvent): void {
    // 데이터와 개행을 나눠 쓰므로 청크 경계가 SSE 프레임 경계라고 가정할 수 없다.
    response.write(`id: ${event.id}\r\nevent: ${event.event}\r\ndata: `)
    response.write(JSON.stringify(event.data)); response.write('\r\n\r\n')
  }
  result(jobId: string): Record<string, unknown> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('Job이 없습니다.')
    return {
      jobId, jobStatus: job.status, createdAt: '2026-11-23T00:00:00Z', terminalAt: job.active ? null : '2026-11-23T00:00:01Z',
      result: job.active || job.status === 'CANCELLED' ? null
        : job.status === 'FAILED' ? { status: 'FAILED', errorCode: 'WORKER_INTERRUPTED', clarification: null, payload: {} }
        : { status: job.status === 'PARTIAL' ? 'PARTIAL' : this.noEvidence ? 'EMPTY' : 'SUCCESS', errorCode: null, clarification: null, payload: {
        answer: this.noEvidence ? { kind: 'NO_EVIDENCE', text: '근거 없음', citations: [], sentences: [] } : {
          kind: job.status === 'PARTIAL' ? 'PARTIAL' : 'ANSWER', text: '<img src=x onerror="window.htmlExecuted=true"> 검증 답변',
          citations: [{ number: 1, evidenceId: 'evidence-1', sourceType: 'SYSTEM', location: { ref: 'system://TEST/item/1' } }],
          sentences: [{ text: '검증 답변', citations: [1] }],
        }, blocks: [{ id: 'block-1', type: 'text', text: '내보내기 자료' }],
      } },
    }
  }
  noEvidence = false
  seedReview(subject = 'alice', state: ReviewStatus = 'OPEN', evidenceType: 'DOCUMENT' | 'SYSTEM' | 'EMPTY' = 'DOCUMENT'): string {
    const feedbackId = `00000000-0000-4000-8000-${String(++this.serial).padStart(12, '0')}`
    const bodyMasked = '검토 근거 <b>실행 금지</b>'
    const evidence = evidenceType === 'EMPTY' ? [] : [{
      number: 1, sourceType: evidenceType, bodyMasked, bodySha256: createHash('sha256').update(bodyMasked).digest('hex'),
      location: evidenceType === 'DOCUMENT' ? { bucket: 'manuals', objectKey: 'guide.md', revision: 'a'.repeat(64), section: '## 안내', lineFrom: 1, lineTo: 3 }
        : { ref: 'system://TEST/item/1' }, permissions: ['READ'],
      ...(evidenceType === 'DOCUMENT' ? {} : { status: 'SUCCESS', observedAt: '2026-11-23T00:00:00Z', missingFields: [], retentionMeta: {}, warnings: [] }),
    }]
    this.feedbacks.set(feedbackId, { subject, detail: {
      feedback: { feedbackId, version: 1, state, rating: 'DOWN', comment: '검토 지적 표식', createdAt: '2026-11-23T00:00:00Z', updatedAt: '2026-11-23T00:00:00Z' },
      answerId: `snapshot-job-${this.serial}`, question: '검토 질문 표식',
      answer: { kind: 'ANSWER', text: '검토 답변 <img src=x onerror="window.reviewExecuted=true">', citations: [], sentences: [] },
      evidence, reviews: [], questionCase: null,
    } })
    return feedbackId
  }
  private feedbackFailure(response: ServerResponse, status: number, code: string): void {
    if (status === 503) response.setHeader('Retry-After', '1')
    this.json(response, status, { code, message: '피드백 요청을 처리할 수 없습니다', requestId: 'gateway-request' })
  }
  private receipt(response: ServerResponse, detail: ReviewDetail): void {
    const { feedbackId, version, state } = detail.feedback
    this.json(response, 200, { feedbackId, version, state })
  }
  private conversationBody(row: SavedConversation): Record<string, unknown> {
    return { id: row.value.id, ownerSystem: 'TEST', ownerActorRef: `actor-${row.subject}`,
      createdAt: row.value.createdAt, updatedAt: row.value.updatedAt, status: row.value.status }
  }
  private json(response: ServerResponse, status: number, body?: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Request-Id': 'test-request' })
    response.end(body === undefined ? undefined : JSON.stringify(body))
  }
  private async handle(request: RecordedRequest, response: ServerResponse): Promise<void> {
    const url = new URL(request.path, this.origin)
    const path = url.pathname.replace(/^\/prefix/, '')
    if (path.endsWith('/assets/widget.js') && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' }); response.end(this.widget); return
    }
    if (path === '/host.js') { response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(this.host); return }
    if (path === '/' || path === '/a' || path === '/b' || path === '/header') {
      const prefix = url.searchParams.get('prefix') === '1' ? '/prefix' : ''
      const css = path === '/b' ? '* { color: rgb(255,0,0); font-size:40px; } button,textarea { background: red; border:20px solid red; }' : '* { font-family: serif; } button { background: yellow; }'
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html data-api-base="${prefix}/api/ai"><head><style>${css}</style><script defer src="/host.js"></script><script defer src="${prefix}/api/ai/assets/widget.js"></script></head><body><div id="host"></div></body></html>`); return
    }
    const overrideIndex = this.overrides.findIndex(rule => rule.method === request.method && rule.path.test(path))
    const override = overrideIndex < 0 ? undefined : this.overrides.splice(overrideIndex, 1)[0]
    if (override && !override.afterAdmission) {
      if (override.hold) {
        this.pendingResponses.add(response)
        response.once('close', () => this.pendingResponses.delete(response))
      } else {
        if (override.retryAfter) response.setHeader('Retry-After', override.retryAfter)
        this.json(response, override.status, override.body)
      }
      return
    }
    if (!request.subject) { this.json(response, 401, { code: 'LOGIN_REQUIRED', message: '로그인이 필요합니다.', requestId: 'test-request' }); return }
    if (path === '/api/ai/session') {
      this.json(response, 200, { subject: request.subject, canReview: this.reviewers.has(request.subject), integrationVersion: '1.0.3',
        csrf: request.headers.authorization ? null : { headerName: 'X-Nori-AI-CSRF', token: 'fake-csrf' } }); return
    }
    if (['POST', 'PUT', 'DELETE'].includes(request.method) && !request.headers.authorization && request.headers['x-nori-ai-csrf'] !== 'fake-csrf') {
      this.json(response, 403, { code: 'CSRF_INVALID', message: '요청 보안 정보를 확인해 주세요.', requestId: 'test-request' }); return
    }
    const evaluation = /^\/api\/ai\/v1\/answers\/([^/]+)\/feedback$/.exec(path)
    if (evaluation && request.method === 'PUT') {
      const answerId = evaluation[1] ?? '', job = this.jobs.get(answerId)
      if (!job || job.subject !== request.subject || !this.conversations.has(job.accepted.conversationId)) { this.feedbackFailure(response, 404, 'NOT_FOUND'); return }
      if (!['SUCCEEDED', 'PARTIAL'].includes(job.status)) { this.feedbackFailure(response, 409, 'ANSWER_NOT_READY'); return }
      const body: unknown = JSON.parse(request.body)
      if (typeof body !== 'object' || body === null || !('rating' in body) || !('comment' in body)
        || Object.keys(body).length !== 2 || !['UP', 'DOWN'].includes(String(body.rating)) || typeof body.comment !== 'string' || [...body.comment].length > 2000) {
        this.feedbackFailure(response, 400, 'INVALID_INPUT'); return
      }
      let saved = [...this.feedbacks.values()].find(row => row.subject === request.subject && row.detail.answerId === answerId)
      if (saved && saved.detail.feedback.rating === body.rating && saved.detail.feedback.comment === body.comment) { this.receipt(response, saved.detail); return }
      if (!saved) {
        const id = this.seedReview(request.subject, 'OPEN', 'SYSTEM')
        saved = this.feedbacks.get(id)
        if (!saved) throw new Error('피드백 대역 생성 실패')
        saved.detail.answerId = answerId
        const conversation = this.conversations.get(job.accepted.conversationId)
        const question = conversation?.messages.find(message => message.messageId === job.accepted.messageId)?.content
        if (typeof question !== 'string') throw new Error('피드백 질문 대역이 없습니다.')
        saved.detail.question = question
        if (this.noEvidence) saved.detail.evidence = []
        const result = this.result(answerId), outer = result.result
        if (typeof outer === 'object' && outer !== null && 'payload' in outer && typeof outer.payload === 'object' && outer.payload !== null
          && 'answer' in outer.payload && typeof outer.payload.answer === 'object' && outer.payload.answer !== null && !Array.isArray(outer.payload.answer)) {
          saved.detail.answer = outer.payload.answer as Record<string, unknown>
        }
        saved.detail.feedback.state = body.rating === 'UP' && body.comment === '' ? 'RESOLVED' : 'OPEN'
      } else {
        saved.detail.feedback.state = saved.detail.feedback.state !== 'OPEN' ? 'OPEN' : body.rating === 'UP' && body.comment === '' ? 'RESOLVED' : 'OPEN'
        saved.detail.feedback.version++
        saved.detail.questionCase = null
      }
      saved.detail.feedback.rating = String(body.rating); saved.detail.feedback.comment = body.comment
      this.receipt(response, saved.detail); return
    }
    const review = /^\/api\/ai\/v1\/reviews(?:\/([^/]+)(\/resolve)?)?$/.exec(path)
    if (review) {
      if (!this.reviewers.has(request.subject)) { this.feedbackFailure(response, 403, 'REVIEW_FORBIDDEN'); return }
      const id = review[1]
      if (!id) {
        const state = url.searchParams.get('state') ?? 'OPEN', after = url.searchParams.get('after') ?? '', limit = Number(url.searchParams.get('limit') ?? '20')
        const offset = after === '' ? 0 : this.reviewPositions.get(`${state}:${after}`)
        if (!['OPEN', 'RESOLVED', 'REJECTED'].includes(state) || !Number.isInteger(limit) || limit < 1 || limit > 100 || offset === undefined) {
          this.feedbackFailure(response, 400, 'INVALID_INPUT'); return
        }
        const rows = [...this.feedbacks.values()].map(row => row.detail.feedback).filter(row => row.state === state)
        const items = rows.slice(offset, offset + limit), last = items.at(-1)
        const nextAfter = offset + limit < rows.length && last ? `${Buffer.from(`${last.createdAt}\n${last.feedbackId}`).toString('base64url')}.${Buffer.alloc(32, 7).toString('base64url')}` : null
        if (nextAfter !== null) { this.reviewPositions.set(`${state}:${nextAfter}`, offset + limit); this.reviewCursors.push(nextAfter) }
        this.json(response, 200, { items, nextAfter }); return
      }
      const saved = this.feedbacks.get(id)
      if (!saved) { this.feedbackFailure(response, 404, 'NOT_FOUND'); return }
      if (!review[2]) { this.json(response, 200, saved.detail); return }
      const body: unknown = JSON.parse(request.body)
      if (typeof body !== 'object' || body === null || !('version' in body) || !('cause' in body) || !('action' in body)) { this.feedbackFailure(response, 400, 'INVALID_INPUT'); return }
      if (body.version !== saved.detail.feedback.version || saved.detail.feedback.state !== 'OPEN') { this.feedbackFailure(response, 409, 'REVIEW_CONFLICT'); return }
      saved.detail.reviews.push({ version: body.version, reviewerRef: `actor-${request.subject}`, cause: body.cause, action: body.action, createdAt: '2026-11-23T00:00:01Z' })
      saved.detail.feedback.version++; saved.detail.feedback.state = body.cause === 'REJECT' ? 'REJECTED' : 'RESOLVED'
      this.receipt(response, saved.detail); return
    }
    if (path === '/api/ai/v1/conversations') {
      if (request.method === 'POST') {
        const id = this.seed(request.subject), row = this.conversations.get(id)
        if (!row) throw new Error('생성한 대화가 없습니다.')
        this.json(response, 201, this.conversationBody(row)); return
      }
      const rows = [...this.conversations.values()].filter(row => row.subject === request.subject).reverse()
      const cursor = url.searchParams.get('after')
      const offset = cursor === null ? 0 : this.cursors.get(`${request.subject}:${cursor}`)
      if (offset === undefined || url.searchParams.get('limit') !== '20') { this.json(response, 400, { message: '요청 입력을 확인해 주세요' }); return }
      const items = rows.slice(offset, offset + 20).map(row => row.value)
      const last = items.at(-1)
      const next = offset + 20 < rows.length && last
        ? `${Buffer.from(`${last.updatedAt}\n${last.id}`).toString('base64url')}.${Buffer.alloc(32, ++this.serial).toString('base64url')}` : null
      if (next !== null) { this.cursors.set(`${request.subject}:${next}`, offset + 20); this.issuedCursors.push(next) }
      this.json(response, 200, { items, nextAfter: next }); return
    }
    const conversationMatch = /^\/api\/ai\/v1\/conversations\/([^/]+)$/.exec(path)
    if (conversationMatch) {
      const id = conversationMatch[1] ?? ''
      const conversation = this.conversations.get(id)
      if (!conversation || conversation.subject !== request.subject) { this.json(response, 404); return }
      if (request.method === 'DELETE') {
        if ([...this.jobs.values()].some(job => job.accepted.conversationId === id && job.active)) { this.json(response, 409, { errorCode: 'CONVERSATION_ACTIVE' }); return }
        this.conversations.delete(id); this.json(response, 204); return
      }
      this.json(response, 200, { conversation: this.conversationBody(conversation), messages: conversation.messages }); return
    }
    const messageMatch = /^\/api\/ai\/v1\/conversations\/([^/]+)\/messages$/.exec(path)
    if (request.method === 'POST' && (path === '/api/ai/v1/query' || messageMatch)) {
      const key = `${request.subject}:${request.headers['idempotency-key']}`
      const digest = path + '\n' + request.body
      const existing = this.keys.get(key)
      let accepted: Accepted
      if (existing) {
        if (existing.digest !== digest) { this.json(response, 409, { error: 'IDEMPOTENCY_KEY_CONFLICT' }); return }
        if (!this.conversations.has(existing.accepted.conversationId)) { this.json(response, 404); return }
        accepted = { ...existing.accepted, queuePosition: 0 }
      } else {
        const conversationId = messageMatch?.[1] ?? this.seed(request.subject)
        const conversation = this.conversations.get(conversationId)
        if (!conversation || conversation.subject !== request.subject) { this.json(response, 404); return }
        const body: unknown = JSON.parse(request.body)
        if (typeof body !== 'object' || body === null || !('query' in body) || typeof body.query !== 'string') throw new Error('질문 본문이 잘못되었습니다.')
        const jobId = `job-${++this.serial}`
        accepted = { jobId, conversationId, messageId: `message-${this.serial}`, queuePosition: 1 }
        conversation.value.title ??= body.query
        conversation.messages.push({ messageId: accepted.messageId, role: 'user', content: body.query })
        this.jobs.set(jobId, { subject: request.subject, accepted, active: true, status: 'QUEUED' })
        this.keys.set(key, { digest, accepted })
        this.replay.set(jobId, [{ id: '1', event: 'job.queued', data: { type: 'job.queued', jobId } }])
      }
      if (override) this.json(response, override.status, override.body)
      else this.json(response, 202, accepted)
      return
    }
    const analysis = /^\/api\/ai\/v1\/analyses\/([^/]+)(.*)$/.exec(path)
    if (analysis) {
      const jobId = analysis[1] ?? '', suffix = analysis[2] ?? ''
      const job = this.jobs.get(jobId)
      if (!job || job.subject !== request.subject || !this.conversations.has(job.accepted.conversationId)) { this.json(response, 404); return }
      if (suffix === '') { this.json(response, 200, this.result(jobId)); return }
      if (suffix === '/cancel') { this.event(jobId, 'job.cancelled', '3'); this.json(response, 204); return }
      if (suffix === '/events') {
        const lastId = request.headers['last-event-id']
        const events = this.replay.get(jobId) ?? []
        const index = lastId === undefined ? -1 : events.findIndex(event => event.id === lastId)
        if (lastId !== undefined && index < 0) { this.json(response, 404); return }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-cache' })
        response.write(': connected\r\n\r\n: heartbeat\n\n: keepalive\n\n')
        const connections = this.streams.get(jobId) ?? new Set<ServerResponse>()
        connections.add(response); this.streams.set(jobId, connections)
        response.once('close', () => connections.delete(response))
        for (const event of events.slice(index + 1)) this.writeEvent(response, event)
        if (!job.active) response.end()
        return
      }
      if (suffix === '/evidence/evidence-1/source') { this.json(response, 200, { maskedText: '저장된 근거 본문 <b>문자열</b>' }); return }
      if (suffix === '/blocks/block-1/export') { this.json(response, 200, { id: 'block-1', type: 'text', text: '내보내기 자료' }); return }
    }
    this.json(response, 404)
  }
  private readonly cursors = new Map<string, number>()
}

export const test = base.extend<{ backend: TestBackend }>({
  // eslint-disable-next-line no-empty-pattern -- 대역은 다른 fixture 수명에 의존하지 않는다.
  backend: async ({}, use) => {
    const backend = new TestBackend()
    try { await backend.start(); await use(backend) }
    finally { await backend.close() }
    expect(backend.errors).toEqual([])
  },
})
export { expect }

export async function login(context: BrowserContext, backend: TestBackend, subject = 'alice'): Promise<void> {
  await context.addCookies([{ name: 'sid', value: subject, url: backend.origin }])
}
export async function openWidget(page: Page, backend: TestBackend, path = '/a'): Promise<void> {
  await page.goto(backend.origin + path)
  await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
  await expect(page.getByRole('button', { name: '새 대화', exact: true })).toBeEnabled()
}
export function questionInput(page: Page) {
  return page.getByRole('textbox', { name: '질문', exact: true })
}
export async function send(page: Page, backend: TestBackend, query = '설비 상태를 알려 주세요.'): Promise<string> {
  const previousJobs = backend.jobs.size
  await questionInput(page).fill(query)
  await page.getByRole('button', { name: '보내기', exact: true }).click()
  await expect.poll(() => backend.jobs.size).toBeGreaterThan(previousJobs)
  const jobId = [...backend.jobs.keys()].at(-1)
  if (!jobId) throw new Error('접수된 Job이 없습니다.')
  await expect(page.getByRole('log')).toContainText('답변을 기다리고 있습니다.')
  return jobId
}
