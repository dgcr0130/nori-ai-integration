import { fillCorrection, reveal } from './redesign-helpers'
import { test, expect, login, openWidget, send, type TestBackend } from './backend'
import type { Page } from '@playwright/test'
import { reviewAction, emptyReviewDraft, type ReviewDraft, type Cause } from '../../src/review'

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const input = (page: Page, name: string) => page.getByRole('textbox', { name, exact: true })
const reviewButton = (page: Page, id: string, backend: TestBackend) => {
  const target = backend.feedbacks.get(id)!.detail.feedback
  const index = [...backend.feedbacks.values()].filter(row => row.detail.feedback.state === target.state).findIndex(row => row.detail.feedback.feedbackId === id)
  return page.getByRole('region', { name: '검토 목록', exact: true }).getByRole('button', { name: /^검토 항목/ }).nth(index)
}
const resolves = (backend: TestBackend) => backend.apiRequests.filter(row => row.method === 'POST' && row.path.endsWith('/resolve'))
const evaluations = (backend: TestBackend) => backend.apiRequests.filter(row => row.method === 'PUT' && row.path.endsWith('/feedback'))
const gatewayError = (code: string) => ({ code,
  message: code === 'AUTHENTICATION_FAILED' || code === 'REQUEST_FORBIDDEN' ? '인증 또는 요청 범위를 확인할 수 없습니다.' : '피드백 요청을 처리할 수 없습니다',
  requestId: 'gateway-request' })
const jarError = (code: string, message: string) => ({ code, message, requestId: 'test-request' })
const location = { bucket: 'manuals', objectKey: 'guide.md', revision: 'a'.repeat(64), section: '## 안내', lineFrom: 1, lineTo: 3 }

async function answer(page: Page, backend: TestBackend): Promise<string> {
  const id = await send(page, backend)
  backend.event(id, 'job.completed', '2')
  await expect(page.getByRole('region', { name: '피드백', exact: true })).toBeVisible()
  await reveal(page, '의견 남기기')
  await expect(button(page, '도움이 됨')).toBeVisible()
  return id
}
async function openReview(page: Page, id: string, backend: TestBackend): Promise<void> {
  await button(page, '검토').click()
  await reviewButton(page, id, backend).click()
  await expect(page.getByRole('region', { name: '검토 상세', exact: true })).toContainText('검토 질문 표식')
  await expect(button(page, '조치 제출')).toBeEnabled()
}
function correction(cause: Cause, maximum: boolean): Record<string, unknown> {
  if (cause === 'REJECT') return { note: maximum ? '😀'.repeat(2000) : '가' }
  const locations = Array.from({ length: maximum ? 6 : cause === 'DOCUMENT' ? 0 : 1 }, () => ({ ...location }))
  if (cause === 'DOCUMENT') return { note: maximum ? '😀'.repeat(2000) : '가', locations }
  const value = {
    correctAnswer: { sentences: Array.from({ length: maximum ? 20 : 1 }, () => ({ text: maximum ? 'x'.repeat(1000) : '가', citations: maximum ? [1, 2, 3, 4, 5, 6] : [1] })) },
    expectedFacts: Array.from({ length: maximum ? 20 : 1 }, () => maximum ? 'x'.repeat(256) : '가'), locations,
  }
  return cause === 'RETRIEVAL' ? { terms: Object.fromEntries(Array.from({ length: maximum ? 20 : 1 }, (_, index) => [`약어${index}`, '풀이'])), ...value } : value
}
async function fillAction(page: Page, cause: Cause, action: Record<string, unknown>): Promise<void> {
  await page.getByRole('combobox', { name: '원인', exact: true }).selectOption(cause)
  if ('note' in action) await input(page, '조치 메모').fill(String(action.note))
  await fillCorrection(page, action)
}

test('피드백 jobId·두 키·빈 지적·응답 ID·같은 본문 version 유지·기존 대화 재열기', async ({ page, context, backend }) => {
  await login(context, backend); await openWidget(page, backend, '/a?prefix=1')
  const acceptedResponse = page.waitForResponse(response => response.url().endsWith('/v1/query'))
  const resultResponse = page.waitForResponse(response => /\/v1\/analyses\/[^/]+$/.test(response.url()))
  const id = await answer(page, backend)
  expect(await (await acceptedResponse).json()).toMatchObject({ jobId: id })
  expect(await (await resultResponse).json()).toMatchObject({ jobId: id })
  const responsePromise = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/feedback'))
  await button(page, '도움이 됨').click()
  const response = await responsePromise
  const receipt: unknown = await response.json()
  expect(response.status()).toBe(200)
  expect(receipt).toEqual({ feedbackId: expect.any(String), version: 1, state: 'RESOLVED' })
  await expect(page.getByRole('region', { name: '피드백', exact: true })).toContainText('처리 완료 · 1차')
  const saved = [...backend.feedbacks.values()].find(row => row.detail.answerId === id)
  expect(saved).toBeDefined()
  await expect(page.getByRole('region', { name: '피드백', exact: true })).not.toContainText(saved!.detail.feedback.feedbackId)
  expect(evaluations(backend)[0]?.path).toBe(`/prefix/api/ai/v1/answers/${id}/feedback`)
  expect(JSON.parse(evaluations(backend)[0]?.body ?? '')).toEqual({ rating: 'UP', comment: '' })
  expect(evaluations(backend)[0]?.headers['x-nori-ai-csrf']).toBe('fake-csrf')
  expect(evaluations(backend)[0]?.headers['idempotency-key']).toBeUndefined()
  const firstPut = backend.apiRequests.findIndex(row => row.method === 'PUT')
  expect(backend.apiRequests[firstPut - 1]?.path).toBe('/prefix/api/ai/session')
  await button(page, '도움이 됨').click()
  await expect.poll(() => evaluations(backend).length).toBe(2)
  await expect(button(page, '도움이 됨')).toBeEnabled()
  expect(saved?.detail.feedback.version).toBe(1)
  await input(page, '지적').fill('변경 지적')
  await button(page, '도움이 안 됨').click()
  await expect(page.getByRole('region', { name: '피드백', exact: true })).toContainText('검토 대기 · 2차')
  await button(page, '대화 목록').click()
  await button(page, '설비 상태를 알려 주세요.').click()
  // 상세 조회가 끝나고 진행 UI가 해제된 뒤 접힌 의견 편집을 다시 연다.
  await expect(page.getByRole('region', { name: '질문 진행', exact: true })).toHaveCount(0)
  await reveal(page, '의견 남기기')
  await expect(input(page, '지적')).toHaveValue('변경 지적')
  await expect(page.getByRole('region', { name: '피드백', exact: true })).toContainText('2차')
})

test('피드백 코드 포인트 2000 허용·2001 요청 0회·409 미성공·다른 사용자 404', async ({ page, context, backend }) => {
  await login(context, backend); await openWidget(page, backend)
  const id = await answer(page, backend)
  await input(page, '지적').fill('😀'.repeat(2000))
  await button(page, '도움이 안 됨').click()
  await expect.poll(() => evaluations(backend).length).toBe(1)
  await expect(button(page, '도움이 안 됨')).toBeEnabled()
  expect(JSON.parse(evaluations(backend)[0]?.body ?? '')).toEqual({ rating: 'DOWN', comment: '😀'.repeat(2000) })
  await input(page, '지적').fill('😀'.repeat(2001))
  await button(page, '도움이 안 됨').click()
  await expect(page.getByRole('alert')).toContainText('0~2000자')
  expect(evaluations(backend)).toHaveLength(1)
  await input(page, '지적').fill('')
  backend.failNext({ method: 'PUT', path: /\/feedback$/, status: 409, body: gatewayError('ANSWER_NOT_READY') })
  await button(page, '도움이 됨').click()
  await expect(page.getByRole('alert')).toContainText('HTTP 409 ANSWER_NOT_READY')
  await expect(page.getByRole('region', { name: '피드백', exact: true })).not.toContainText('접수되었습니다.')
  await expect(button(page, '다시 보내기')).toHaveCount(0)
  expect(evaluations(backend)).toHaveLength(2)
  const foreign = await context.request.put(`${backend.origin}/api/ai/v1/answers/${id}/feedback`, {
    headers: { Authorization: 'Bearer bob' }, data: { rating: 'DOWN', comment: '' },
  })
  expect(foreign.status()).toBe(404); expect(await foreign.json()).toEqual(gatewayError('NOT_FOUND'))
})

test('비검토자 탭 숨김과 검토 API 직접 호출 403', async ({ page, context, backend }) => {
  await login(context, backend); await openWidget(page, backend)
  await expect(button(page, '검토')).toHaveCount(0)
  const response = await context.request.get(`${backend.origin}/api/ai/v1/reviews`)
  expect(response.status()).toBe(403); expect(await response.json()).toEqual(gatewayError('REVIEW_FORBIDDEN'))
})

test('검토 빈 목록·상태별 목록·불투명 커서·닫힌 상세 읽기 전용·문자열 렌더링', async ({ page, context, backend }) => {
  backend.reviewers.add('alice')
  await login(context, backend); await openWidget(page, backend)
  await button(page, '검토').click()
  await expect(page.getByRole('region', { name: '검토 목록', exact: true })).toContainText('검토 항목이 없습니다.')
  for (let index = 0; index < 21; index++) backend.seedReview()
  const resolved = backend.seedReview('alice', 'RESOLVED'), rejected = backend.seedReview('alice', 'REJECTED')
  await button(page, '검토 목록 새로고침').click()
  await expect(page.getByRole('region', { name: '검토 목록', exact: true }).getByRole('article')).toHaveCount(20)
  const cursor = backend.reviewCursors.at(-1)
  await button(page, '검토 다음 쪽').click()
  await expect(page.getByRole('region', { name: '검토 목록', exact: true }).getByRole('article')).toHaveCount(1)
  await expect(button(page, '검토 다음 쪽')).toHaveCount(0)
  const lists = backend.apiRequests.filter(row => row.path.includes('/v1/reviews?'))
  expect(new URL(lists.at(-1)?.path ?? '', backend.origin).searchParams.get('after')).toBe(cursor)
  expect(new URL(lists.at(-1)?.path ?? '', backend.origin).searchParams.get('limit')).toBe('20')
  for (const [status, id] of [['RESOLVED', resolved], ['REJECTED', rejected]]) {
    await page.getByRole('combobox', { name: '검토 상태', exact: true }).selectOption(status ?? '')
    await reviewButton(page, id!, backend).click()
    const detail = page.getByRole('region', { name: '검토 상세', exact: true })
    await expect(detail).toContainText('검토 대기 상태에서만 조치할 수 있습니다.')
    await reveal(page, '당시 근거')
    await reveal(page, '기존 조치 · 재발 문항')
    await expect(detail).toContainText('근거 본문')
    await expect(detail).toContainText('<img src=x onerror=')
    await expect(detail).toContainText('없음')
    await expect(button(page, '조치 제출')).toHaveCount(0)
    await expect(page.locator('nori-ai-widget').locator('img,b')).toHaveCount(0)
    expect(await page.evaluate(() => Reflect.get(window, 'reviewExecuted'))).toBeUndefined()
  }
})

for (const cause of ['DOCUMENT', 'RETRIEVAL', 'ANSWER', 'REJECT'] as const) {
  for (const maximum of [false, true]) {
    test(`${cause} ${maximum ? '최대' : '최소'} 입력의 resolve 본문·version·이력`, async ({ page, context, backend }) => {
      if (maximum) test.setTimeout(0)
      backend.reviewers.add('alice')
      const id = backend.seedReview()
      await login(context, backend); await openWidget(page, backend); await openReview(page, id, backend)
      const action = correction(cause, maximum)
      await fillAction(page, cause, action)
      await button(page, '조치 제출').click()
      await expect.poll(() => resolves(backend).length).toBe(1)
      expect(JSON.parse(resolves(backend)[0]?.body ?? '')).toEqual({ version: 1, cause, action })
      expect(resolves(backend)[0]?.headers['x-nori-ai-csrf']).toBe('fake-csrf')
      await expect(page.getByRole('region', { name: '검토 상세', exact: true })).toContainText('2차')
      await expect(button(page, '조치 제출')).toHaveCount(0)
      const detail = backend.feedbacks.get(id)?.detail
      expect(detail?.reviews).toHaveLength(1)
      expect(detail?.feedback.state).toBe(cause === 'REJECT' ? 'REJECTED' : 'RESOLVED')
    })
  }
}

test('검토 범위 밖·JSON 오류·Unicode 길이·줄바꿈·인용 번호는 요청 0회', async ({ page, context, backend }) => {
  backend.reviewers.add('alice')
  const id = backend.seedReview()
  await login(context, backend); await openWidget(page, backend); await openReview(page, id, backend)
  const cases: { cause: Cause; field: string; value: unknown; error: string }[] = [
    { cause: 'DOCUMENT', field: '조치 메모', value: '', error: '조치 메모' },
    { cause: 'DOCUMENT', field: '조치 메모', value: '😀'.repeat(2001), error: '조치 메모' },
    { cause: 'DOCUMENT', field: '문서 위치', value: Array(7).fill(location), error: '문서 위치' },
    { cause: 'REJECT', field: '조치 메모', value: '', error: '조치 메모' },
    { cause: 'REJECT', field: '조치 메모', value: '😀'.repeat(2001), error: '조치 메모' },
    { cause: 'RETRIEVAL', field: '용어', value: {}, error: '용어' },
    { cause: 'RETRIEVAL', field: '용어', value: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`용어${index}`, '풀이'])), error: '용어' },
    { cause: 'ANSWER', field: '문서 위치', value: [], error: '문서 위치' },
    { cause: 'ANSWER', field: '문서 위치', value: Array(7).fill(location), error: '문서 위치' },
    { cause: 'ANSWER', field: '문서 위치', value: '[', error: 'JSON' },
    { cause: 'ANSWER', field: '핵심 사실', value: [], error: '핵심 사실' },
    { cause: 'ANSWER', field: '핵심 사실', value: Array(21).fill('가'), error: '핵심 사실' },
    { cause: 'ANSWER', field: '핵심 사실', value: [''], error: '핵심 사실' },
    { cause: 'ANSWER', field: '핵심 사실', value: ['😀'.repeat(257)], error: '핵심 사실' },
    { cause: 'ANSWER', field: '정답 문장', value: [], error: '정답 문장' },
    { cause: 'ANSWER', field: '정답 문장', value: Array(21).fill({ text: '가', citations: [1] }), error: '정답 문장' },
    ...['', '😀'.repeat(1001)].map(value => ({ cause: 'ANSWER' as const, field: '정답 문장', value: [{ text: value, citations: [1] }], error: '정답 문장' })),
    ...['\n', '\r', '\u0085', '\u2028', '\u2029'].map(value => ({ cause: 'ANSWER' as const, field: '정답 문장', value: [{ text: `가${value}나`, citations: [1] }], error: '줄바꿈' })),
    ...[[], [1, 1, 1, 1, 1, 1, 1], [0], [2], [1.5]].map(citations => ({ cause: 'ANSWER' as const, field: '정답 문장', value: [{ text: '가', citations }], error: '문장 인용' })),
    { cause: 'ANSWER', field: '문서 위치', value: [1], error: '문서 위치: 객체로 입력해 주세요.' },
    { cause: 'ANSWER', field: '핵심 사실', value: [1], error: '핵심 사실: 문자열로 입력해 주세요.' },
    { cause: 'ANSWER', field: '정답 문장', value: [1], error: '정답 문장: 객체로 입력해 주세요.' },
    { cause: 'ANSWER', field: '정답 문장', value: [{ text: 1, citations: [1] }], error: '정답 문장: 문자열로 입력해 주세요.' },
    { cause: 'ANSWER', field: '정답 문장', value: [{ text: '가', citations: 1 }], error: '문장 인용: 배열 형식으로 입력해 주세요.' },
    { cause: 'RETRIEVAL', field: '용어', value: [], error: '용어: 객체로 입력해 주세요.' },
    { cause: 'RETRIEVAL', field: '용어', value: { 약어: 1 }, error: '용어: 문자열로 입력해 주세요.' },
    { cause: 'ANSWER', field: '문서 위치', value: {}, error: '문서 위치: 배열 형식으로 입력해 주세요.' },
    { cause: 'ANSWER', field: '핵심 사실', value: {}, error: '핵심 사실: 배열 형식으로 입력해 주세요.' },
    { cause: 'ANSWER', field: '정답 문장', value: {}, error: '정답 문장: 배열 형식으로 입력해 주세요.' },
  ]
  for (const entry of cases) {
    const action = correction(entry.cause, false)
    const draft: ReviewDraft = { ...emptyReviewDraft(), cause: entry.cause, note: String(action.note ?? ''),
      locations: JSON.stringify(action.locations ?? []), terms: JSON.stringify(action.terms ?? {}),
      sentences: JSON.stringify((action.correctAnswer as { sentences: unknown[] } | undefined)?.sentences ?? []), expectedFacts: JSON.stringify(action.expectedFacts ?? []) }
    const field = ({ '조치 메모': 'note', '문서 위치': 'locations', '용어': 'terms', '정답 문장': 'sentences', '핵심 사실': 'expectedFacts' } as const)[entry.field as '조치 메모']
    draft[field] = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value)
    expect(() => reviewAction(draft, backend.feedbacks.get(id)!.detail)).toThrow(entry.error)
    expect(resolves(backend)).toHaveLength(0)
  }
})

for (const cause of ['DOCUMENT', 'RETRIEVAL', 'ANSWER', 'REJECT'] as const) {
  test(`실시간 근거 ${cause}는 note 전용`, async ({ page, context, backend }) => {
    backend.reviewers.add('alice')
    const id = backend.seedReview('alice', 'OPEN', 'SYSTEM')
    await login(context, backend); await openWidget(page, backend); await openReview(page, id, backend)
    await page.getByRole('combobox', { name: '원인', exact: true }).selectOption(cause)
    await expect(page.getByRole('region', { name: '문서 위치 편집', exact: true })).toHaveCount(0)
    await input(page, '조치 메모').fill('실시간 조치 표식')
    await button(page, '조치 제출').click()
    await expect.poll(() => resolves(backend).length).toBe(1)
    expect(JSON.parse(resolves(backend)[0]?.body ?? '')).toEqual({ version: 1, cause, action: { note: '실시간 조치 표식' } })
  })
}

test('빈 근거는 note 전용이 아니며 Gateway 의미 검증은 400으로 표시한다', async ({ page, context, backend }) => {
  backend.reviewers.add('alice')
  const id = backend.seedReview('alice', 'OPEN', 'EMPTY')
  await login(context, backend); await openWidget(page, backend); await openReview(page, id, backend)
  await expect(page.getByRole('button', { name: '문서 위치 추가', exact: true })).toBeVisible()
  const action = { ...correction('RETRIEVAL', false), terms: { ['가'.repeat(65)]: '가'.repeat(257) },
    locations: [{ ...location, revision: '형식 검증은 서버', lineFrom: 9, lineTo: 1 }] }
  await fillAction(page, 'RETRIEVAL', action)
  backend.failNext({ method: 'POST', path: /\/resolve$/, status: 400, body: gatewayError('INVALID_INPUT') })
  await button(page, '조치 제출').click()
  await expect(page.getByRole('alert')).toContainText('HTTP 400 INVALID_INPUT')
  expect(JSON.parse(resolves(backend)[0]?.body ?? '')).toEqual({ version: 1, cause: 'RETRIEVAL', action })
  await fillAction(page, 'REJECT', { note: ' ' })
  backend.failNext({ method: 'POST', path: /\/resolve$/, status: 400, body: gatewayError('INVALID_INPUT') })
  await button(page, '조치 제출').click()
  await expect.poll(() => resolves(backend).length).toBe(2)
  await expect(button(page, '조치 제출')).toBeEnabled()
})

test('Unicode 최대 길이의 문장·사실은 허용하고 HTTP 본문 64KiB 초과는 요청 0회', async ({ page, context, backend }) => {
  backend.reviewers.add('alice')
  const id = backend.seedReview()
  await login(context, backend); await openWidget(page, backend); await openReview(page, id, backend)
  const small = { ...correction('ANSWER', false), correctAnswer: { sentences: [{ text: '😀'.repeat(1000), citations: [1] }] }, expectedFacts: ['😀'.repeat(256)] }
  await fillAction(page, 'ANSWER', small)
  backend.failNext({ method: 'POST', path: /\/resolve$/, status: 400, body: gatewayError('INVALID_INPUT') })
  await button(page, '조치 제출').click()
  await expect(page.getByRole('alert')).toContainText('HTTP 400 INVALID_INPUT')
  expect(JSON.parse(resolves(backend)[0]?.body ?? '').action).toEqual(small)
  const large = { ...small, correctAnswer: { sentences: Array.from({ length: 20 }, () => ({ text: '😀'.repeat(1000), citations: [1] })) } }
  await fillAction(page, 'ANSWER', large)
  await button(page, '조치 제출').click()
  await expect(page.getByRole('alert')).toContainText('64KiB')
  expect(resolves(backend)).toHaveLength(1)
})

for (const [status, code] of [[400, 'INPUT_INVALID'], [400, 'INVALID_INPUT'], [401, 'AUTHENTICATION_FAILED'],
  [403, 'REQUEST_FORBIDDEN'], [404, 'NOT_FOUND'], [503, 'GATEWAY_UNAVAILABLE'], [503, 'KNOWLEDGE_UNAVAILABLE']] as const) {
  test(`피드백 ${status} ${code} 구별 표시·자동 재전송 없음`, async ({ page, context, backend }) => {
    await login(context, backend); await openWidget(page, backend); await answer(page, backend)
    await input(page, '지적').fill('오류 뒤 보존 표식')
    const body = code === 'INPUT_INVALID' ? jarError(code, '요청 입력을 확인해 주세요.')
      : code === 'GATEWAY_UNAVAILABLE' ? jarError(code, 'AI 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.') : gatewayError(code)
    backend.failNext({ method: 'PUT', path: /\/feedback$/, status, body, retryAfter: status === 503 ? '1' : undefined })
    await button(page, '도움이 안 됨').click()
    await expect(page.getByRole('alert')).toContainText(`HTTP ${status} ${code}`)
    await expect(input(page, '지적')).toHaveValue('오류 뒤 보존 표식')
    await expect(button(page, '다시 보내기')).toHaveCount(0)
    expect(evaluations(backend)).toHaveLength(1)
    if (status === 503) await expect(page.getByText('다시 시도할 수 있는 시간: 1초 후', { exact: true })).toBeVisible()
  })
}

for (const [status, code, message] of [[503, 'AUTH_UNAVAILABLE', '로그인 정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.'],
  [500, 'AUTH_RESULT_INVALID', '로그인 정보 처리에 오류가 발생했습니다.'], [500, 'SIGNING_FAILED', 'AI 요청 인증 정보를 만들 수 없습니다.']] as const) {
  test(`피드백 전 ${code}의 message 유지·메모리 격리 후 같은 신원 복구`, async ({ page, context, backend }) => {
    await login(context, backend); await openWidget(page, backend); await answer(page, backend)
    await input(page, '지적').fill('인증 오류 정리 표식')
    backend.failNext({ method: 'GET', path: /\/session$/, status, body: jarError(code, message) })
    await button(page, '도움이 안 됨').click()
    await expect(page.getByRole('alert')).toHaveText(message)
    await expect(input(page, '지적')).toHaveCount(0)
    await expect(button(page, '검토')).toHaveCount(0)
    expect(evaluations(backend)).toHaveLength(0)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await reveal(page, '의견 남기기')
    await expect(input(page, '지적')).toHaveValue('인증 오류 정리 표식')
    expect(evaluations(backend)).toHaveLength(0)
  })
}

test('피드백·검토도 HEADER 공급자를 요청마다 읽고 CSRF·멱등 키를 더하지 않는다', async ({ page, backend }) => {
  backend.reviewers.add('alice')
  const id = backend.seedReview()
  await page.goto(backend.origin + '/header')
  await page.locator('nori-ai-widget').evaluate(element => {
    Reflect.set(window, 'phase5Headers', 0)
    Reflect.set(element, 'requestHeaders', async () => {
      Reflect.set(window, 'phase5Headers', Number(Reflect.get(window, 'phase5Headers')) + 1)
      return { Authorization: 'Bearer alice', 'X-Actor-Assertion': '필터 대상', 'X-Nori-AI-CSRF': '필터 대상' }
    })
  })
  await button(page, 'AI 대화 열기').click()
  await expect(button(page, '새 대화')).toBeEnabled()
  await answer(page, backend)
  await button(page, '도움이 됨').click()
  await expect(page.getByRole('region', { name: '피드백', exact: true })).toContainText('접수되었습니다.')
  await openReview(page, id, backend)
  await input(page, '조치 메모').fill('헤더 조치')
  await button(page, '조치 제출').click()
  await expect(button(page, '조치 제출')).toHaveCount(0)
  await expect(button(page, '검토')).toBeEnabled()
  const records = backend.apiRequests
  expect(await page.evaluate(() => Reflect.get(window, 'phase5Headers'))).toBe(records.length)
  for (const row of records) {
    expect(row.headers.authorization).toBe('Bearer alice')
    expect(row.headers['x-nori-ai-csrf']).toBeUndefined()
    expect(row.headers['x-actor-assertion']).toBeUndefined()
  }
  for (const row of [...evaluations(backend), ...resolves(backend)]) expect(row.headers['idempotency-key']).toBeUndefined()
})

test('구 version 충돌 뒤 목록·상세 재조회·양식 초기화·자동 제출 0회', async ({ page, context, backend }) => {
  backend.reviewers.add('alice')
  const id = backend.seedReview(), saved = backend.feedbacks.get(id)
  if (!saved) throw new Error('시험 피드백이 없습니다.')
  await login(context, backend); await openWidget(page, backend); await openReview(page, id, backend)
  await input(page, '조치 메모').fill('구 version 입력')
  saved.detail.feedback.version = 2; saved.detail.question = '새 상세 질문 표식'
  const before = backend.apiRequests.length
  await button(page, '조치 제출').click()
  await expect(page.getByRole('alert')).toContainText('HTTP 409 REVIEW_CONFLICT')
  await expect(page.getByRole('region', { name: '검토 상세', exact: true })).toContainText('새 상세 질문 표식')
  await expect(input(page, '조치 메모')).toHaveValue('')
  await expect(page.getByRole('region', { name: '검토 조치', exact: true })).toContainText('검토 조치')
  expect(resolves(backend)).toHaveLength(1)
  const requests = backend.apiRequests.slice(before)
  expect(requests.filter(row => row.method === 'GET' && row.path.includes('/reviews?'))).toHaveLength(1)
  expect(requests.filter(row => row.method === 'GET' && row.path.endsWith(`/reviews/${id}`))).toHaveLength(1)
  await input(page, '조치 메모').fill('새 상세 확인 후 입력')
  await button(page, '조치 제출').click()
  await expect.poll(() => resolves(backend).length).toBe(2)
  expect(JSON.parse(resolves(backend)[1]?.body ?? '').version).toBe(2)
})

test('열린 검토 권한 회수는 제출 0회·탭과 목록·상세·양식 삭제', async ({ page, context, backend }) => {
  backend.reviewers.add('alice')
  const id = backend.seedReview()
  await login(context, backend); await openWidget(page, backend); await openReview(page, id, backend)
  await input(page, '조치 메모').fill('회수 전 양식 표식')
  backend.reviewers.delete('alice')
  const before = backend.apiRequests.length
  await button(page, '조치 제출').click()
  await expect(button(page, '검토')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '검토 상세', exact: true })).toHaveCount(0)
  expect(backend.apiRequests.slice(before).filter(row => row.path.includes('/v1/reviews'))).toHaveLength(0)
  backend.reviewers.add('alice')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await openReview(page, id, backend)
  await expect(input(page, '조치 메모')).toHaveValue('')
})

for (const status of [403, 404]) {
  for (const operation of ['상세', '제출']) {
    test(`Gateway ${status} ${operation} 뒤 기존 상세 본문 삭제`, async ({ page, context, backend }) => {
      backend.reviewers.add('alice')
      const id = backend.seedReview()
      await login(context, backend); await openWidget(page, backend); await openReview(page, id, backend)
      await input(page, '조치 메모').fill('이전 양식 표식')
      backend.failNext({ method: operation === '상세' ? 'GET' : 'POST', path: operation === '상세' ? new RegExp(`/reviews/${id}$`) : /\/resolve$/,
        status, body: gatewayError(status === 403 ? 'REVIEW_FORBIDDEN' : 'NOT_FOUND') })
      if (operation === '상세') await reviewButton(page, id, backend).click()
      else await button(page, '조치 제출').click()
      await expect(page.getByRole('alert')).toContainText(`HTTP ${status}`)
      await expect(page.getByRole('region', { name: '검토 상세', exact: true })).toHaveCount(0)
      if (status === 403) await expect(button(page, '검토')).toHaveCount(0)
      expect(resolves(backend)).toHaveLength(operation === '제출' ? 1 : 0)
    })
  }
}

for (const [status, code] of [[400, 'INVALID_INPUT'], [503, 'KNOWLEDGE_UNAVAILABLE'], [401, 'AUTHENTICATION_FAILED']] as const) {
  test(`Gateway ${status} ${code} 표시·메모리 유지·자동 재전송 0회`, async ({ page, context, backend }) => {
    backend.reviewers.add('alice')
    const id = backend.seedReview()
    await login(context, backend); await openWidget(page, backend); await openReview(page, id, backend)
    await input(page, '조치 메모').fill('보존 양식 표식')
    backend.failNext({ method: 'POST', path: /\/resolve$/, status, body: gatewayError(code), retryAfter: status === 503 ? '1' : undefined })
    await button(page, '조치 제출').click()
    await expect(page.getByRole('alert')).toContainText(`HTTP ${status} ${code}`)
    await expect(input(page, '조치 메모')).toHaveValue('보존 양식 표식')
    await expect(page.getByRole('region', { name: '검토 상세', exact: true })).toContainText('검토 질문 표식')
    await expect(page.getByRole('alert')).not.toContainText('로그인이 필요합니다.')
    if (status === 503) await expect(page.getByText('다시 시도할 수 있는 시간: 1초 후', { exact: true })).toBeVisible()
    expect(resolves(backend)).toHaveLength(1)
    await expect(button(page, '다시 보내기')).toHaveCount(0)
  })
}

test('jar LOGIN_REQUIRED는 피드백·검토·대화 메모리와 스트림을 비운다', async ({ page, context, backend }) => {
  backend.reviewers.add('alice')
  const id = backend.seedReview()
  await login(context, backend); await openWidget(page, backend)
  await answer(page, backend)
  await input(page, '지적').fill('피드백 보관 금지 표식')
  await button(page, '도움이 안 됨').click()
  await expect(button(page, '도움이 안 됨')).toBeEnabled()
  await send(page, backend, '진행 중 표식')
  await expect.poll(() => backend.openStreams).toBe(1)
  await openReview(page, id, backend)
  await input(page, '조치 메모').fill('검토 보관 금지 표식')
  backend.failNext({ method: 'GET', path: /\/session$/, status: 401,
    body: { code: 'LOGIN_REQUIRED', message: '로그인이 필요합니다.', requestId: 'test-request' } })
  await button(page, '조치 제출').click()
  await expect(page.getByRole('alert')).toHaveText('로그인이 필요합니다.')
  await expect.poll(() => backend.openStreams).toBe(0)
  await expect(page.getByRole('region', { name: '검토 상세', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '질문 진행', exact: true })).toHaveCount(0)
  await expect(input(page, '지적')).toHaveCount(0)
  expect(resolves(backend)).toHaveLength(0)
})

test('피드백·검토 저장소 표식 0·닫기·사용자 변경·태그 제거 뒤 연결 0', async ({ page, context, backend }) => {
  backend.reviewers.add('alice')
  const id = backend.seedReview()
  await login(context, backend); await openWidget(page, backend)
  await answer(page, backend)
  await input(page, '지적').fill('피드백 영속 금지 표식')
  await button(page, '도움이 안 됨').click()
  await expect(button(page, '도움이 안 됨')).toBeEnabled()
  await openReview(page, id, backend)
  await input(page, '조치 메모').fill('검토 영속 금지 표식')
  expect(await page.evaluate(async () => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage),
    databases: await indexedDB.databases(), caches: await caches.keys() }))).toEqual({ local: [], session: [], databases: [], caches: [] })
  await button(page, 'AI 대화 최소화').click()
  await button(page, 'AI 대화 열기').click()
  await expect(input(page, '조치 메모')).toHaveValue('검토 영속 금지 표식')
  await expect(input(page, '지적')).toHaveCount(0)
  await login(context, backend, 'bob')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(button(page, '검토')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '검토 상세', exact: true })).toHaveCount(0)
  await send(page, backend, '제거 시 진행 중 표식')
  await expect.poll(() => backend.openStreams).toBe(1)
  await page.locator('nori-ai-widget').evaluate(element => element.remove())
  await expect.poll(() => backend.openStreams).toBe(0)
  expect(backend.pendingResponses.size).toBe(0)
})

test('태그 제거는 진행 중인 검토 fetch도 취소한다', async ({ page, context, backend }) => {
  backend.reviewers.add('alice')
  const id = backend.seedReview()
  await login(context, backend); await openWidget(page, backend)
  await button(page, '검토').click()
  backend.failNext({ method: 'GET', path: new RegExp(`/reviews/${id}$`), status: 200, hold: true })
  await reviewButton(page, id, backend).click()
  await expect.poll(() => backend.pendingResponses.size).toBe(1)
  await page.locator('nori-ai-widget').evaluate(element => element.remove())
  await expect.poll(() => backend.pendingResponses.size).toBe(0)
  expect(backend.openStreams).toBe(0)
})
