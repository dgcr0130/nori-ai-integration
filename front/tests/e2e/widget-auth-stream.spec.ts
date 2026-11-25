import { test, expect, login, openWidget, questionInput, send } from './backend'

test('requestHeaders 동기·Promise를 매 요청 호출하고 금지 이름·CSRF·credentials를 적용한다', async ({ page, context, backend }) => {
  await login(context, backend)
  await page.goto(backend.origin + '/header?prefix=1')
  await page.locator('nori-ai-widget').evaluate(element => {
    let calls = 0
    Reflect.set(window, 'headerCalls', () => calls)
    Reflect.set(element, 'requestHeaders', () => {
      const value = { Authorization: 'Bearer alice', 'X-Call': String(++calls),
        aCcEpT: 'forbidden', 'Content-Type': 'forbidden', Cookie: 'sid=mallory', Host: 'other.invalid',
        'Idempotency-Key': 'forbidden', 'Last-Event-ID': 'forbidden', 'X-Nori-AI-CSRF': 'forbidden',
        'X-Actor-Assertion': 'forbidden', 'X-Request-Id': 'forbidden' }
      return calls % 2 === 0 ? Promise.resolve(value) : value
    })
    const originalFetch = window.fetch.bind(window)
    const credentials: (RequestCredentials | undefined)[] = []
    Reflect.set(window, 'widgetCredentials', credentials)
    window.fetch = (input, init) => { credentials.push(init?.credentials); return originalFetch(input, init) }
  })
  await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
  await expect(page.getByRole('button', { name: '새 대화', exact: true })).toBeEnabled()
  const jobId = await send(page, backend)
  backend.event(jobId, 'job.completed', '2')
  await expect(page.getByRole('region', { name: '답변', exact: true })).toBeVisible()
  expect(backend.apiRequests.filter(row => /evidence|export/.test(row.path))).toHaveLength(0)
  const api = backend.apiRequests
  const calls = await page.evaluate(() => {
    const getter: unknown = Reflect.get(window, 'headerCalls')
    if (typeof getter !== 'function') throw new Error('호출 기록이 없습니다.')
    return getter() as number
  })
  expect(calls).toBe(api.length)
  expect(api.every(request => request.path.startsWith('/prefix/api/ai/'))).toBe(true)
  expect(api.map(request => Number(request.headers['x-call'])).sort((a, b) => a - b)).toEqual(Array.from({ length: calls }, (_, index) => index + 1))
  for (const request of api) {
    expect(request.headers.authorization).toBe('Bearer alice')
    expect(request.headers.accept).not.toBe('forbidden')
    expect(request.headers['content-type']).not.toBe('forbidden')
    expect(request.headers.cookie).toContain('sid=alice')
    expect(request.headers.host).toBe(new URL(backend.origin).host)
    expect(request.headers['idempotency-key']).not.toBe('forbidden')
    expect(request.headers['last-event-id']).toBeUndefined()
    expect(request.headers['x-nori-ai-csrf']).toBeUndefined()
    expect(request.headers['x-actor-assertion']).toBeUndefined()
    expect(request.headers['x-request-id']).toBeUndefined()
  }
  const credentials = await page.evaluate(() => Reflect.get(window, 'widgetCredentials') as unknown)
  expect(credentials).toEqual(Array.from({ length: calls }, () => 'same-origin'))
  const assets = backend.requests.filter(row => row.path.endsWith('/assets/widget.js'))
  expect(assets).toHaveLength(1)
  expect(assets[0]?.headers.authorization).toBeUndefined()
  await page.getByRole('button', { name: 'AI 대화 최소화', exact: true }).click()
  await page.locator('nori-ai-widget').evaluate(element => Reflect.deleteProperty(element, 'requestHeaders'))
  await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
  await expect(page.getByRole('button', { name: '새 대화', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '새 대화', exact: true }).click()
  await expect.poll(() => backend.apiRequests.filter(row => row.method === 'POST' && row.path.endsWith('/conversations')).length).toBe(1)
  const creation = backend.apiRequests.at(-1)
  // 목록 GET이 POST 뒤에 올 수 있으므로 변경 요청 자체를 대조한다.
  const post = backend.apiRequests.find(row => row.method === 'POST' && row.path.endsWith('/conversations'))
  expect(post?.headers.authorization).toBeUndefined()
  expect(post?.headers['x-nori-ai-csrf']).toBe('fake-csrf')
  expect(creation?.headers['x-call']).toBeUndefined()
})

for (const mode of ['throw', 'null', 'string', 'array', 'non-string', 'forbidden-non-string'] as const) {
  test(`requestHeaders ${mode}는 로그인 안내·전송 0회이다`, async ({ page, context, backend }) => {
    await login(context, backend)
    await page.goto(backend.origin + '/a')
    await page.locator('nori-ai-widget').evaluate((element, kind) => {
      Reflect.set(element, 'requestHeaders', () => {
        if (kind === 'throw') throw new Error('시험 인증 오류')
        if (kind === 'null') return null
        if (kind === 'string') return 'Bearer alice'
        if (kind === 'array') return ['Bearer alice']
        if (kind === 'forbidden-non-string') return { Accept: 42 }
        return Promise.resolve({ Authorization: 42 })
      })
    }, mode)
    await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('로그인이 필요합니다.')
    expect(backend.apiRequests).toHaveLength(0)
    await expect(page.getByRole('region', { name: '대화 내용', exact: true })).toHaveCount(0)
  })
}

for (const [code, status, message] of [
  ['AUTH_UNAVAILABLE', 503, '로그인 정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.'],
  ['AUTH_RESULT_INVALID', 500, '로그인 정보 처리에 오류가 발생했습니다.'],
  ['SIGNING_FAILED', 500, 'AI 요청 인증 정보를 만들 수 없습니다.'],
  ['LOGIN_REQUIRED', 401, '로그인이 필요합니다.'],
] as const) {
  test(`${code}의 message를 로그인 안내와 구별한다`, async ({ page, context, backend }) => {
    await login(context, backend)
    backend.failNext({ method: 'GET', path: /\/session$/, status, body: { code, message, requestId: 'test-request' } })
    await page.goto(backend.origin + '/a')
    await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(message)
    await expect(page.getByRole('region', { name: '대화 내용', exact: true })).toHaveCount(0)
    expect(backend.apiRequests).toHaveLength(1)
  })
}

test('Gateway 401·503과 본문 없는 접수 거절을 로그인 만료·응답 불명으로 바꾸지 않는다', async ({ page, context, backend }) => {
  await login(context, backend)
  await openWidget(page, backend)
  for (const error of [
    { status: 401, body: { message: '서비스 인증을 확인할 수 없습니다', requestId: 'gateway-request' }, expected: '서비스 인증을 확인할 수 없습니다' },
    { status: 503, body: { error: 'INFERENCE_UNAVAILABLE' }, expected: 'HTTP 503 INFERENCE_UNAVAILABLE' },
    { status: 404, body: undefined, expected: 'HTTP 404' },
  ]) {
    backend.failNext({ method: 'POST', path: /\/query$/, status: error.status, body: error.body, retryAfter: error.status === 503 ? '60' : undefined })
    await questionInput(page).fill('거절 질문')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(error.expected)
    await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toHaveCount(0)
    await expect(questionInput(page)).toHaveValue('거절 질문')
    if (error.status === 503) await expect(page.getByText('다시 시도할 수 있는 시간: 60초 후', { exact: true })).toBeVisible()
  }
  expect(backend.jobs.size).toBe(0)
})

test('익명 자산은 읽히며 API는 쿠키·헤더 없이 LOGIN_REQUIRED이다', async ({ page, backend }) => {
  await page.goto(backend.origin + '/header?prefix=1')
  await expect(page.getByRole('button', { name: 'AI 대화 열기', exact: true })).toBeVisible()
  const asset = backend.requests.find(row => row.path.endsWith('/assets/widget.js'))
  expect(asset?.subject).toBeNull()
  await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('로그인이 필요합니다.')
  expect(backend.apiRequests).toHaveLength(1)
})

test('열린 창 focus의 사용자 변경은 대화·질문·SSE를 지우며 닫힌 창 focus는 요청하지 않는다', async ({ page, context, backend }) => {
  await login(context, backend)
  await openWidget(page, backend)
  await send(page, backend, '사용자 변경 표식')
  await expect.poll(() => backend.openStreams).toBe(1)
  await login(context, backend, 'bob')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('region', { name: '질문 진행', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '대화 내용', exact: true })).toHaveText('')
  await expect.poll(() => backend.openStreams).toBe(0)
  await page.getByRole('button', { name: '대화 목록', exact: true }).click()
  await expect(page.getByText('대화가 없습니다.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'AI 대화 최소화', exact: true }).click()
  const requests = backend.apiRequests.length
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('button', { name: 'AI 대화 열기', exact: true })).toBeVisible()
  expect(backend.apiRequests.length).toBe(requests)
})

test('SSE 첫 표시·주석·무종결 중단·사용자 재연결·마지막 id 재생·결과 조회', async ({ page, context, backend }) => {
  await login(context, backend)
  await openWidget(page, backend)
  const jobId = await send(page, backend)
  await expect.poll(() => backend.openStreams).toBe(1)
  backend.event(jobId, 'job.started', '2', { jobStatus: 'RUNNING' })
  await expect(page.getByRole('log')).toContainText('답변을 준비하고 있습니다.')
  expect(backend.openStreams).toBe(1)
  await expect(page.getByRole('region', { name: '답변', exact: true })).toHaveCount(0)
  const sessionCount = backend.apiRequests.filter(row => row.path.endsWith('/session')).length
  backend.interrupt(jobId)
  await expect(page.getByRole('button', { name: '다시 연결', exact: true })).toBeVisible()
  expect(backend.apiRequests.filter(row => row.path.endsWith('/session')).length).toBe(sessionCount + 1)
  expect(backend.apiRequests.filter(row => row.path.endsWith('/events'))).toHaveLength(1)
  await page.getByRole('button', { name: '결과 다시 조회', exact: true }).click()
  await expect(page.getByRole('region', { name: '답변', exact: true })).toHaveText('답변을 준비하고 있습니다.')
  backend.event(jobId, 'tool.started', '3', { toolId: 'test.read', status: 'RUNNING' })
  await page.getByRole('button', { name: '다시 연결', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('자료를 확인하고 있습니다.')
  const reconnect = backend.apiRequests.filter(row => row.path.endsWith('/events'))
  expect(reconnect).toHaveLength(2)
  expect(reconnect[1]?.headers['last-event-id']).toBe('2')
  expect(reconnect[1]?.headers.authorization).toBeUndefined()
  await expect(page.getByRole('log').getByText('자료를 확인하고 있습니다.', { exact: true })).toHaveCount(1)
  backend.event(jobId, 'job.partial', '4')
  await expect(page.getByRole('region', { name: '답변', exact: true })).toContainText('검증 답변')
  await expect(page.getByRole('button', { name: '취소', exact: true })).toHaveCount(0)
  await expect.poll(() => backend.openStreams).toBe(0)
})

test('헤더 로그인 SSE 재연결도 requestHeaders와 Last-Event-ID를 함께 보낸다', async ({ page, backend }) => {
  await page.goto(backend.origin + '/header')
  await page.locator('nori-ai-widget').evaluate(element => Reflect.set(element, 'requestHeaders', async () => ({ Authorization: 'Bearer alice' })))
  await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
  await expect(page.getByRole('button', { name: '새 대화', exact: true })).toBeEnabled()
  const jobId = await send(page, backend)
  backend.interrupt(jobId)
  await expect(page.getByRole('button', { name: '다시 연결', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '다시 연결', exact: true }).click()
  await expect.poll(() => backend.apiRequests.filter(row => row.path.endsWith('/events')).length).toBe(2)
  const request = backend.apiRequests.filter(row => row.path.endsWith('/events'))[1]
  expect(request?.headers.authorization).toBe('Bearer alice')
  expect(request?.headers['last-event-id']).toBe('1')
})

test('SSE 종결 없는 종료 뒤 session 401은 메모리·스트림을 지우고 로그인만 안내한다', async ({ page, context, backend }) => {
  await login(context, backend)
  await openWidget(page, backend)
  const jobId = await send(page, backend, '로그아웃 비공개 표식')
  await context.clearCookies()
  backend.interrupt(jobId)
  await expect(page.getByRole('alert')).toHaveText('로그인이 필요합니다.')
  await expect(page.getByRole('region', { name: '질문 진행', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '대화 내용', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '다시 연결', exact: true })).toHaveCount(0)
  await expect.poll(() => backend.openStreams).toBe(0)
  expect(backend.apiRequests.filter(row => row.path.endsWith('/events'))).toHaveLength(1)
})

test('결과 DENIED는 답변과 의견을 회수하고 토큰 단위 답변을 만들지 않는다', async ({ page, context, backend }) => {
  await login(context, backend); await openWidget(page, backend)
  const jobId = await send(page, backend)
  backend.event(jobId, 'job.started', '2', { jobStatus: 'RUNNING' })
  await expect(page.getByRole('log')).toContainText('답변을 준비하고 있습니다.')
  await expect(page.getByRole('region', { name: '답변', exact: true })).toHaveCount(0)
  await page.route(`**/v1/analyses/${jobId}`, route => route.fulfill({ json: {
    jobId, jobStatus: 'SUCCEEDED', resultAccess: 'DENIED', result: null,
  } }))
  backend.event(jobId, 'job.completed', '3')
  await expect(page.getByText('결과를 읽을 권한이 없습니다.', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '피드백', exact: true })).toHaveCount(0)
  await expect(page.locator('main')).not.toContainText('검증 답변')
  expect(backend.apiRequests.filter(row => /evidence|export/.test(row.path))).toHaveLength(0)
})

test('태그 제거 중 requestHeaders Promise가 완료되어도 backend로 전송하지 않는다', async ({ page, backend }) => {
  await page.goto(backend.origin + '/a')
  await page.locator('nori-ai-widget').evaluate(element => {
    Reflect.set(element, 'requestHeaders', () => new Promise<Record<string, string>>(resolve => {
      Reflect.set(window, 'releaseHeaders', () => resolve({ Authorization: 'Bearer alice' }))
    }))
  })
  await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
  await expect.poll(() => page.evaluate(() => Reflect.has(window, 'releaseHeaders'))).toBe(true)
  await page.locator('nori-ai-widget').evaluate(element => element.remove())
  await page.evaluate(() => {
    const release: unknown = Reflect.get(window, 'releaseHeaders')
    if (typeof release !== 'function') throw new Error('헤더 대기가 없습니다.')
    release()
  })
  await expect(page.getByRole('button', { name: 'AI 대화 열기', exact: true })).toHaveCount(0)
  expect(backend.apiRequests).toHaveLength(0)
})

for (const terminal of ['job.failed', 'job.cancelled'] as const) {
  test(`${terminal} 종결 뒤 취소가 비활성이고 검증 결과만 읽는다`, async ({ page, context, backend }) => {
    await login(context, backend)
    await openWidget(page, backend)
    const jobId = await send(page, backend)
    backend.event(jobId, terminal, '2')
    // 종결 결과를 받으면 진행 영역은 사라지고 실패·취소 상태는 답변 영역에 남는다.
    await expect(page.getByRole('region', { name: '답변', exact: true })).toContainText(terminal === 'job.failed' ? '답변 처리 중 오류가 발생했습니다.' : '질문이 취소되었습니다.')
    await expect(page.getByRole('region', { name: '질문 진행', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '취소', exact: true })).toHaveCount(0)
    await expect.poll(() => backend.openStreams).toBe(0)
  })
}

test('태그 제거는 SSE·대기 fetch·구독·위젯 타이머를 정리한다', async ({ page, context, backend }) => {
  await login(context, backend)
  await page.addInitScript(() => {
    const timeouts = new Set<number>(), intervals = new Set<number>()
    const setTimeoutOriginal = window.setTimeout.bind(window), clearTimeoutOriginal = window.clearTimeout.bind(window)
    const setIntervalOriginal = window.setInterval.bind(window), clearIntervalOriginal = window.clearInterval.bind(window)
    Reflect.set(window, 'setTimeout', (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof handler !== 'function') return setTimeoutOriginal(handler, delay, ...args)
      const id = setTimeoutOriginal(() => { timeouts.delete(id); handler(...args) }, delay)
      timeouts.add(id); return id
    })
    Reflect.set(window, 'clearTimeout', (id?: number) => { if (id !== undefined) timeouts.delete(id); clearTimeoutOriginal(id) })
    Reflect.set(window, 'setInterval', (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      const id = setIntervalOriginal(handler, delay, ...args); intervals.add(id); return id
    })
    Reflect.set(window, 'clearInterval', (id?: number) => { if (id !== undefined) intervals.delete(id); clearIntervalOriginal(id) })
    Reflect.set(window, 'liveTestTimers', () => timeouts.size + intervals.size)
  })
  await openWidget(page, backend)
  await send(page, backend)
  await expect.poll(() => backend.openStreams).toBe(1)
  backend.failNext({ method: 'GET', path: /\/session$/, status: 200, hold: true })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => backend.pendingResponses.size).toBe(1)
  await page.locator('nori-ai-widget').evaluate(element => element.remove())
  await expect.poll(() => backend.openStreams).toBe(0)
  await expect.poll(() => backend.pendingResponses.size).toBe(0)
  await expect.poll(async () => page.evaluate(() => {
    const getter: unknown = Reflect.get(window, 'liveTestTimers')
    if (typeof getter !== 'function') throw new Error('타이머 기록이 없습니다.')
    return getter() as number
  })).toBe(0)
  const requests = backend.apiRequests.length
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  expect(backend.apiRequests.length).toBe(requests)
  await page.locator('#host-counter').click()
  await expect(page.locator('#host-counter')).toHaveText('호스트 1')
})
