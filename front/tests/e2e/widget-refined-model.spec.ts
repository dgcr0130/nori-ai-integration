import { test, expect } from '@playwright/test'
import { ConversationModel, displayAnswer } from '../../src/conversation'
import { AiApi, ApiFailure, type Session } from '../../src/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const alice: Session = { subject: 'alice', canReview: false, csrf: null, integrationVersion: '1.0.6' }
const detail = (id: string, body = id) => ({ conversation: { id }, messages: [{ messageId: id, role: 'assistant', content: body }] })
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }

class FakeApi {
  csrf: Session['csrf'] = null
  sessions = 0
  calls: string[] = []
  sessionImpl = async () => alice
  requestImpl: (path: string, options?: { method?: string }) => Promise<unknown> = async path => path.includes('?') ? { items: [{ id: 'c1', title: '첫 대화' }], nextAfter: null } : detail(path.split('/').at(-1)!)
  async session() { this.sessions++; return this.sessionImpl() }
  async request(path: string, options: { method?: string } = {}) { this.calls.push(`${options.method ?? 'GET'} ${path}`); return this.requestImpl(path, options) }
  async consume(_path: string, options: { signal: AbortSignal }) {
    return new Promise<boolean>(resolve => {
      if (options.signal.aborted) resolve(false)
      else options.signal.addEventListener('abort', () => resolve(false), { once: true })
    })
  }
  cancelAll() { this.csrf = null }
  dispose() {}
}
async function ready() {
  const api = new FakeApi(), model = new ConversationModel(api as unknown as AiApi)
  await model.focus(true); await model.open('c1')
  return { api, model }
}

test('A 인증: 삭제와 중복 focus는 SESSION 1 / DELETE 1이며 느린 상세로 잠그지 않는다', async () => {
  const { api, model } = await ready()
  const auth = deferred<Session>(), read = deferred<unknown>()
  const before = api.sessions
  api.sessionImpl = () => auth.promise
  api.requestImpl = async path => path.includes('?') ? { items: [], nextAfter: null } : read.promise
  const previous = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } })
  try {
    const deletion = model.remove('c1'), focus = model.focus(), duplicate = model.focus()
    expect(api.sessions - before).toBe(1)
    auth.resolve(alice); await tick()
    read.resolve({}); await Promise.all([deletion, focus, duplicate])
    expect(api.calls.filter(row => row === 'DELETE /v1/conversations/c1')).toHaveLength(1)
    expect(model.snapshot().conversationId).toBeNull()
  } finally { model.dispose(); Object.defineProperty(globalThis, 'window', { configurable: true, value: previous }) }
})

test('A 상세: 삭제 뒤 늦은 성공은 대화를 되살리지 않는다', async () => {
  const { api, model } = await ready(), old = deferred<unknown>()
  api.requestImpl = async path => path.includes('?') ? { items: [], nextAfter: null } : old.promise
  const focus = model.focus(); await tick()
  const previous = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } })
  try {
    api.requestImpl = async () => ({ items: [], nextAfter: null })
    await model.remove('c1')
    old.resolve(detail('c1', '폐기할 내용')); await focus
    expect(model.snapshot().conversationId).toBeNull()
    expect(model.snapshot().messages).toEqual([])
  } finally { model.dispose(); Object.defineProperty(globalThis, 'window', { configurable: true, value: previous }) }
})

test('A 상세: 인증 성공 후 느린 GET은 인증 잠금을 유지하지 않는다', async () => {
  const { api, model } = await ready(), old = deferred<unknown>()
  api.requestImpl = async path => path.includes('?') ? { items: [], nextAfter: null } : old.promise
  try {
    const focus = model.focus(); await tick()
    expect(model.snapshot().validating).toBe(false)
    const start = api.calls.length
    api.requestImpl = async () => ({ items: [], nextAfter: null, ...detail('c1') })
    await model.reload()
    expect(api.calls.slice(start).some(row => row.includes('?'))).toBe(true)
    old.resolve(detail('c1')); await focus
  } finally { old.resolve(detail('c1')); model.dispose() }
})

for (const status of [200, 403, 404]) test(`A 선택: 오래된 c1 응답 ${status}와 open 후속 처리를 폐기한다`, async () => {
  const { api, model } = await ready(), old = deferred<unknown>()
  api.requestImpl = async path => path.endsWith('/c1') ? old.promise : detail('c2')
  try {
    const first = model.open('c1'); await model.open('c2')
    if (status === 200) old.resolve(detail('c1', '오래된 본문'))
    else old.reject(new ApiFailure(status, { message: '오래된 오류' }, new Headers()))
    await first
    expect(model.snapshot().conversationId).toBe('c2')
    expect(model.snapshot().notice).toBe('')
  } finally { model.dispose() }
})

test('A 새로고침: 목록 실패에도 상세를 독립 반영한다', async () => {
  const { api, model } = await ready()
  api.requestImpl = async path => { if (path.includes('?')) throw new Error('목록 실패'); return detail('c1', '새 본문') }
  try {
    await model.reload()
    expect(model.snapshot().messages[0]?.content).toBe('새 본문')
    expect(model.snapshot().listFailed).toBe(true)
  } finally { model.dispose() }
})

for (const mode of ['signed-out', 'invalidate', 'check', 'dispose', 'bob'] as const) test(`A 인증 회수 ${mode}: 대기 삭제와 늦은 인증의 finally를 폐기한다`, async () => {
  const { api, model } = await ready(), old = deferred<Session>(), fresh = deferred<Session>()
  api.sessionImpl = () => old.promise
  const previous = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } })
  try {
    const command = model.remove('c1'), focus = model.focus()
    if (mode === 'bob') {
      old.resolve({ ...alice, subject: 'bob' })
      await Promise.all([command, focus])
    } else {
      api.sessionImpl = () => fresh.promise
      if (mode === 'dispose') model.dispose()
      else model.invalidateAuth(mode)
      old.resolve(alice); await Promise.all([command, focus])
      if (mode === 'check') {
        expect(model.snapshot().validating).toBe(true)
        expect(model.snapshot().ready).toBe(false)
        fresh.resolve({ ...alice, subject: 'bob' }); await tick()
        expect(model.snapshot().ready).toBe(true)
      } else expect(model.snapshot().ready).toBe(false)
    }
    expect(api.calls.filter(row => row.startsWith('DELETE'))).toHaveLength(0)
    expect(model.snapshot().messages).toEqual([])
  } finally { fresh.resolve(alice); model.dispose(); Object.defineProperty(globalThis, 'window', { configurable: true, value: previous }) }
})

test('A 인증은 완료 후 캐시하지 않으며 재열기 focus도 접수한 명령 인증을 취소하지 않는다', async () => {
  const { api, model } = await ready(), auth = deferred<Session>()
  const previous = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } })
  try {
    const count = api.sessions
    api.sessionImpl = () => auth.promise
    const command = model.remove('c1'), focus = model.focus(true), second = model.focus(true)
    expect(api.sessions - count).toBe(1)
    auth.resolve(alice); await Promise.all([command, focus, second])
    expect(api.calls.filter(row => row.startsWith('DELETE'))).toHaveLength(1)
    await model.focus(); expect(api.sessions - count).toBe(2)
  } finally { model.dispose(); Object.defineProperty(globalThis, 'window', { configurable: true, value: previous }) }
})

test('A 상세: 같은 대화의 나중 요청만 반영하며 상세 실패에도 목록은 성공한다', async () => {
  const { api, model } = await ready(), old = deferred<unknown>()
  try {
    api.requestImpl = () => old.promise
    const first = model.open('c1')
    api.requestImpl = async () => detail('c1', '새 본문')
    await model.open('c1'); old.resolve(detail('c1', '이전 본문')); await first
    expect(model.snapshot().messages[0]?.content).toBe('새 본문')
    api.requestImpl = async path => {
      if (!path.includes('?')) throw new Error('상세 실패')
      return { items: [{ id: 'c2', title: '목록 성공' }], nextAfter: null }
    }
    await model.reload()
    expect(model.snapshot().items[0]?.title).toBe('목록 성공')
    expect(model.snapshot().listFailed).toBe(false)
    expect(model.snapshot().detailFailed).toBe(true)
  } finally { model.dispose() }
})

test('A 표시 투영: 중복·불일치 레거시와 직접 표·도움말·배열 표기는 보존한다', () => {
  const sentence = '배열 [1]과 포트 6100, 버전 26.07.11.0000입니다.'
  const canonical = { text: sentence + '[1]\n직접 표 [6100]', sentences: [{ text: sentence, citations: [1] }], citations: [{ number: 1 }] }
  expect(displayAnswer(canonical)).toBe(sentence + '\n직접 표 [6100]')
  expect(canonical.text).toBe(sentence + '[1]\n직접 표 [6100]')
  const duplicate = { ...canonical, text: canonical.text + '\n' + canonical.text }
  expect(displayAnswer(duplicate)).toBe(duplicate.text)
  expect(displayAnswer({ ...canonical, sentences: [] })).toBe(canonical.text)
  expect(displayAnswer({ ...canonical, citations: [{ number: 2 }] })).toBe(canonical.text)
  expect(displayAnswer({ ...canonical, sentences: [null, '레거시 문장'] })).toBe(canonical.text)
  expect(displayAnswer({ text: '도움말 6100 [1]', sentences: [], citations: [] })).toBe('도움말 6100 [1]')
})

for (const response of ['DENIED', '403'] as const) test(`A 근거 ${response} 회수 뒤 늦은 성공도 보호 메모리를 복구하지 않는다`, async () => {
  const { api, model } = await ready(), old = deferred<unknown>()
  api.requestImpl = async path => {
    if (path.includes('/e1/')) return old.promise
    if (response === '403') throw new ApiFailure(403, { message: '권한 거부' }, new Headers())
    return { resultAccess: 'DENIED' }
  }
  try {
    const first = model.toggleEvidence('j1', 'e1')
    await model.toggleEvidence('j1', 'e2')
    old.resolve({ maskedText: '지연된 비공개 표식' }); await first
    expect(model.snapshot().sources).toEqual({})
  } finally { model.dispose() }
})

for (const action of ['send', 'feedback'] as const) for (const identity of ['signed-out', 'bob'] as const) {
  test(`A 대기 ${action}: ${identity} 신원 회수 뒤 POST/PUT 0회`, async () => {
    const { api, model } = await ready(), old = deferred<Session>()
    api.sessionImpl = () => old.promise
    try {
      model.setQuery('원래 질문')
      const command = action === 'send' ? model.send() : model.feedback('j1', 'UP')
      const focus = model.focus()
      if (identity === 'signed-out') model.invalidateAuth('signed-out')
      old.resolve(identity === 'bob' ? { ...alice, subject: 'bob' } : alice)
      await Promise.all([command, focus])
      expect(api.calls.filter(row => /^(POST|PUT) /.test(row))).toEqual([])
    } finally { model.dispose() }
  })
}

test('A DELETE CSRF 거부 뒤에는 자동 재인증·재전송하지 않는다', async () => {
  const { api, model } = await ready()
  const previous = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } })
  api.requestImpl = async () => { throw new ApiFailure(403, { code: 'CSRF_INVALID', message: 'CSRF 확인 실패' }, new Headers()) }
  try {
    const sessions = api.sessions
    await model.remove('c1')
    expect(api.sessions - sessions).toBe(1)
    expect(api.calls.filter(row => row.startsWith('DELETE'))).toHaveLength(1)
    expect(model.snapshot().notice).toBe('CSRF 확인 실패')
  } finally { model.dispose(); Object.defineProperty(globalThis, 'window', { configurable: true, value: previous }) }
})

for (const operation of ['sidebar', 'next', 'reload'] as const) for (const identity of ['alice', 'bob', 'signed-out', 'unavailable'] as const) {
  test(`A-R2 ${operation}: 인증 대기 요청0과 ${identity} 해제 후 원래 작업 결속`, async () => {
    const { api, model } = await ready(), auth = deferred<Session>()
    const cursor = 'opaque +/=% 다음'
    api.requestImpl = async path => path.includes('?')
      ? { items: [{ id: 'c1', title: 'Alice 항목' }], nextAfter: cursor } : detail('c1')
    await model.reload()
    model.setSidebar(true); model.setSidebar(false)
    api.calls = []
    api.sessionImpl = () => auth.promise
    api.requestImpl = async path => path.includes('?')
      ? { items: [{ id: 'b1', title: 'Bob private 항목' }], nextAfter: null } : detail('c1')
    const focus = model.focus()
    let pending: Promise<void> = Promise.resolve()
    try {
      if (operation === 'sidebar') model.setSidebar(true)
      else pending = model[operation]()
      await tick()
      expect([...api.calls]).toEqual([])
      expect(model.snapshot().items.some(row => row.id === 'b1')).toBe(false)
      if (identity === 'signed-out') model.invalidateAuth('signed-out')
      if (identity === 'unavailable') auth.reject(new Error('인증 확인 불가'))
      else auth.resolve(identity === 'bob' ? { ...alice, subject: 'bob', csrf: { headerName: 'X-CSRF', token: 'bob-token' } } : alice)
      await Promise.all([focus, pending]); await tick()
      const pages = api.calls.filter(row => row.includes('after='))
      if (identity === 'alice') {
        expect(api.calls.filter(row => row.includes('/conversations?'))).toHaveLength(1)
        if (operation === 'next') expect(new URL('https://fixture.invalid' + pages[0]!.slice(4)).searchParams.get('after')).toBe(cursor)
        else expect(pages).toHaveLength(0)
        if (operation === 'reload') expect(api.calls.filter(row => row === 'GET /v1/conversations/c1')).toHaveLength(1)
      } else if (identity === 'bob') {
        // 새 신원의 초기 목록만 허용한다. 이전 페이지/대상 상세는 실행하지 않는다.
        expect(api.calls).toEqual(['GET /v1/conversations?limit=20'])
        expect(api.csrf?.token).toBe('bob-token')
        expect(model.snapshot().conversationId).toBeNull()
      } else {
        expect(api.calls).toEqual([])
        expect(api.csrf).toBeNull()
        expect(model.snapshot().ready).toBe(false)
      }
    } finally { auth.resolve(alice); model.dispose(); await Promise.all([focus, pending]) }
  })
}

test('A-R2 중복 자동 pagination은 인증 뒤 현재 불투명 cursor를 한 번만 소비한다', async () => {
  const { api, model } = await ready(), auth = deferred<Session>()
  const cursor = 'opaque +/=% 현재'
  api.requestImpl = async path => path.includes('?') ? { items: [], nextAfter: cursor } : detail('c1')
  await model.reload(); api.calls = []
  api.sessionImpl = () => auth.promise
  api.requestImpl = async path => path.includes('?') ? { items: [], nextAfter: null } : detail('c1')
  const focus = model.focus(), first = model.next(), duplicate = model.next()
  try {
    await tick(); expect(api.calls).toEqual([])
    auth.resolve(alice); await Promise.all([focus, first, duplicate])
    const pages = api.calls.filter(row => row.includes('after='))
    expect(pages).toHaveLength(1)
    expect(new URL('https://fixture.invalid' + pages[0]!.slice(4)).searchParams.get('after')).toBe(cursor)
  } finally { auth.resolve(alice); model.dispose() }
})

test('A-R2 전송 후 시작된 인증 대기도 늦은 자료의 반영과 CSRF 복구를 막는다', async () => {
  const { api, model } = await ready(), auth = deferred<Session>(), response = deferred<unknown>()
  api.requestImpl = () => response.promise
  const read = model.reload(); await tick()
  api.sessionImpl = () => auth.promise
  const focus = model.focus()
  try {
    response.resolve({ items: [{ id: 'b1', title: 'Bob private 항목' }], nextAfter: null, ...detail('c1', '늦은 비공개 본문') })
    await tick()
    expect(model.snapshot().items.some(row => row.id === 'b1')).toBe(false)
    expect(model.snapshot().messages[0]?.content).toBe('c1')
    model.invalidateAuth('signed-out'); auth.resolve(alice)
    await Promise.all([focus, read])
    expect(model.snapshot().items).toEqual([])
    expect(model.snapshot().messages).toEqual([])
    expect(api.csrf).toBeNull()
  } finally { auth.resolve(alice); model.dispose() }
})

for (const command of ['cancel', 'feedback'] as const) for (const identity of ['alice', 'bob', 'signed-out'] as const) {
  test(`A-R2 명령 ${command}: 공유 인증 뒤 ${identity} 신원과 단회 전송 유지`, async () => {
    const { api, model } = await ready(), auth = deferred<Session>()
    api.requestImpl = async (path, options) => {
      if (path.endsWith('/messages')) return { jobId: 'j1', conversationId: 'c1', messageId: 'm1', queuePosition: 0 }
      if (path.endsWith('/feedback')) return { feedbackId: 'f1', version: 1, state: 'OPEN' }
      if (path.endsWith('/analyses/j1')) return { jobId: 'j1', jobStatus: 'CANCELLED', result: null }
      if (options?.method === 'POST') return null
      return path.includes('?') ? { items: [], nextAfter: null } : detail('c1')
    }
    if (command === 'cancel') { model.setQuery('진행 질문'); await model.send() }
    api.calls = []; const sessions = api.sessions
    api.sessionImpl = () => auth.promise
    const focus = model.focus()
    const first = command === 'cancel' ? model.cancel() : model.feedback('j1', 'UP')
    const duplicate = command === 'cancel' ? model.cancel() : model.feedback('j1', 'UP')
    try {
      await tick(); expect(api.calls.filter(row => /^(PUT|POST)/.test(row))).toEqual([])
      if (identity === 'signed-out') model.invalidateAuth('signed-out')
      auth.resolve(identity === 'bob' ? { ...alice, subject: 'bob' } : alice)
      await Promise.all([focus, first, duplicate])
      expect(api.sessions - sessions).toBe(1)
      expect(api.calls.filter(row => /^(PUT|POST)/.test(row))).toHaveLength(identity === 'alice' ? 1 : 0)
    } finally { auth.resolve(alice); model.dispose() }
  })
}
