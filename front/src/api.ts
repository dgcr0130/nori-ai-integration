export type RequestHeaders = () => Record<string, string> | Promise<Record<string, string>>

export interface WidgetHost extends HTMLElement {
  requestHeaders?: RequestHeaders
}

export interface Session {
  subject: string
  canReview: boolean
  integrationVersion: string
  csrf: { headerName: string; token: string } | null
}

const forbiddenHeaders = new Set([
  'accept', 'content-type', 'cookie', 'host', 'idempotency-key', 'last-event-id',
  'x-nori-ai-csrf', 'x-actor-assertion', 'x-request-id',
])

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('응답 형식을 확인할 수 없습니다.')
  return value as Record<string, unknown>
}

export function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('응답 형식을 확인할 수 없습니다.')
  return value
}

export class LoginRequired extends Error {
  constructor() { super('로그인이 필요합니다.') }
}

export class TransportFailure extends Error {
  constructor() { super('응답을 확인할 수 없습니다.') }
}

export class ApiFailure extends Error {
  readonly code: string | undefined
  readonly retryAfter: string | null

  constructor(readonly status: number, readonly body: unknown, headers: Headers) {
    const fields = typeof body === 'object' && body !== null && !Array.isArray(body) ? object(body) : {}
    const code = [fields.code, fields.errorCode, fields.error].find(value => typeof value === 'string')
    const message = typeof fields.message === 'string' ? fields.message : typeof code === 'string' ? code : `HTTP ${status}`
    super(typeof fields.message === 'string' || typeof code !== 'string' ? message : `HTTP ${status} ${message}`)
    this.code = typeof code === 'string' ? code : undefined
    this.retryAfter = headers.get('Retry-After')
  }

  get loginRequired(): boolean { return this.status === 401 && this.code === 'LOGIN_REQUIRED' }
  get identityFailure(): boolean {
    return this.loginRequired || (this.status === 503 && this.code === 'AUTH_UNAVAILABLE')
      || (this.status === 500 && (this.code === 'AUTH_RESULT_INVALID' || this.code === 'SIGNING_FAILED'))
  }
  get uncertain(): boolean {
    return (this.status === 503 && this.code === 'GATEWAY_UNAVAILABLE')
      || (this.status === 504 && this.code === 'GATEWAY_TIMEOUT')
  }
}

export function apiBase(value: string | null): string {
  if (!value || !value.startsWith('/') || value.endsWith('/') || /\/\/|\.\.|[?#\\\s]/.test(value)) return '/api/ai'
  // URL 정규화가 경로를 다른 대상으로 바꾸는 이스케이프도 허용하지 않는다.
  try {
    const decoded = decodeURIComponent(value)
    if (/\/\/|\.\.|[?#\\\s]/.test(decoded)) return '/api/ai'
    if (new URL(value, location.origin).origin !== location.origin) return '/api/ai'
  } catch { return '/api/ai' }
  return value
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: string
  key?: string
  lastId?: string
  signal?: AbortSignal
  accept?: string
}

export class AiApi {
  csrf: Session['csrf'] = null
  private readonly controllers = new Set<AbortController>()
  private disposed = false

  constructor(private readonly host: WidgetHost, readonly base: string) {}

  cancelAll(): void {
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.csrf = null
  }

  dispose(): void { this.disposed = true; this.cancelAll() }

  private async headers(options: Options): Promise<Headers> {
    const headers = new Headers()
    const supplier = this.host.requestHeaders
    if (supplier !== undefined) {
      if (typeof supplier !== 'function') throw new LoginRequired()
      try {
        const values: unknown = await supplier.call(this.host)
        const entries = Object.entries(object(values))
        // 금지 이름도 먼저 문자열 계약을 검사한다. 잘못된 인증 입력은 전송하지 않는다.
        for (const [name, value] of entries) {
          if (typeof value !== 'string') throw new LoginRequired()
          if (!forbiddenHeaders.has(name.toLowerCase())) headers.set(name, value)
        }
      } catch { throw new LoginRequired() }
    }
    headers.set('Accept', options.accept ?? 'application/json')
    if (options.body !== undefined) headers.set('Content-Type', 'application/json')
    if (options.key !== undefined) headers.set('Idempotency-Key', options.key)
    if (options.lastId) headers.set('Last-Event-ID', options.lastId)
    if (options.method && options.method !== 'GET' && this.csrf) headers.set(this.csrf.headerName, this.csrf.token)
    return headers
  }

  async consume<T>(path: string, options: Options, consume: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    this.controllers.add(controller)
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      const headers = await this.headers(options)
      if (this.disposed || options.signal?.aborted) controller.abort()
      controller.signal.throwIfAborted()
      let response: Response
      try {
        response = await fetch(this.base + path, {
          method: options.method ?? 'GET', body: options.body, headers,
          credentials: 'same-origin', signal: controller.signal, redirect: 'error', cache: 'no-store',
        })
      } catch (error) {
        if (controller.signal.aborted) throw error
        throw new TransportFailure()
      }
      if (!response.ok) throw new ApiFailure(response.status, await readBody(response), response.headers)
      const value = await consume(response)
      controller.signal.throwIfAborted()
      return value
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      throw error
    } finally {
      controller.abort()
      options.signal?.removeEventListener('abort', abort)
      this.controllers.delete(controller)
    }
  }

  request(path: string, options: Options = {}): Promise<unknown> {
    return this.consume(path, options, readBody)
  }

  async session(signal?: AbortSignal): Promise<Session> {
    const value = object(await this.request('/session', { signal }))
    const csrf = value.csrf === null ? null : object(value.csrf)
    if (typeof value.canReview !== 'boolean') throw new Error('응답 형식을 확인할 수 없습니다.')
    const session = {
      subject: text(value.subject), canReview: value.canReview, integrationVersion: text(value.integrationVersion),
      csrf: csrf === null ? null : { headerName: text(csrf.headerName), token: text(csrf.token) },
    }
    if (!session.subject.trim() || !session.integrationVersion.trim()
      || (session.csrf !== null && !session.csrf.token.trim())) throw new Error('응답 형식을 확인할 수 없습니다.')
    if (session.csrf !== null) {
      try { new Headers([[session.csrf.headerName, session.csrf.token]]) }
      catch { throw new Error('응답 형식을 확인할 수 없습니다.') }
    }
    return session
  }
}

async function readBody(response: Response): Promise<unknown> {
  let body: string
  try { body = await response.text() } catch { throw new TransportFailure() }
  if (!body) return null
  if (!(response.headers.get('Content-Type') ?? '').includes('json')) return body
  try { return JSON.parse(body) as unknown } catch { throw new Error('응답 형식을 확인할 수 없습니다.') }
}

export function questionContext(now = new Date()): { timezone: string; referenceTime: string } {
  const pad = (value: number) => String(value).padStart(2, '0')
  const offsetMinutes = -now.getTimezoneOffset()
  const offset = `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`
  let timezone: string | undefined
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone } catch { timezone = undefined }
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`
  return { timezone: timezone || offset, referenceTime: `${date}T${time}${offset}` }
}
