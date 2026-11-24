import { reveal } from './redesign-helpers'
import { test, expect, login, openWidget, questionInput, send } from './backend'

test('별도 React와 서로 다른 전역 CSS에서도 같은 태그·화면·Shadow 스타일을 쓴다', async ({ browser, backend }) => {
  for (const path of ['/a', '/b']) {
    const context = await browser.newContext()
    try {
      await login(context, backend)
      const page = await context.newPage()
      await openWidget(page, backend, path)
      await page.locator('#host-counter').click()
      await expect(page.locator('#host-counter')).toHaveText('호스트 1')
      const values = await page.evaluate(() => {
        const host = document.querySelector('nori-ai-widget')
        const panel = host?.shadowRoot?.querySelector('.panel')
        const button = host?.shadowRoot?.querySelector('header button')
        if (!host || !panel || !button) throw new Error('위젯 화면이 없습니다.')
        return { shadow: Boolean(host.shadowRoot), background: getComputedStyle(button).backgroundColor,
          font: getComputedStyle(button).fontSize, width: panel.getBoundingClientRect().width,
          height: panel.getBoundingClientRect().height, hostReact: Reflect.has(window, 'hostReact') }
      })
      expect(values).toEqual({ shadow: true, background: 'rgb(255, 255, 255)', font: '14px', width: 440, height: 600, hostReact: true })
      await expect(page.getByRole('button', { name: '대화', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '대화 목록', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '보내기', exact: true })).toBeDisabled()
      await page.getByRole('button', { name: 'AI 대화 최소화', exact: true }).click()
    } finally { await context.close() }
  }
})

test('크기 상한·위치·색 기본값과 잘못된 api-base·미등록 속성을 처리한다', async ({ page, context, backend }) => {
  await login(context, backend)
  await page.setViewportSize({ width: 320, height: 480 })
  await page.goto(backend.origin + '/a')
  await page.locator('nori-ai-widget').evaluate(element => {
    element.setAttribute('position', 'top-left')
    element.setAttribute('api-base', 'https://other.invalid/api')
    element.setAttribute('renderer', 'other')
    element.style.setProperty('--nori-ai-width', '-1px')
    element.style.setProperty('--nori-ai-height', 'auto')
    element.style.setProperty('--nori-ai-accent', 'invalid-color')
  })
  await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
  await expect(page.getByRole('button', { name: '새 대화', exact: true })).toBeEnabled()
  const panel = page.locator('nori-ai-widget').locator('.panel')
  await expect(panel).toHaveCSS('width', '288px')
  await expect(panel).toHaveCSS('height', '448px')
  await expect(page.locator('.frame')).toHaveCSS('--accent', '#2563eb')
  await expect(page.locator('nori-ai-widget').locator('.frame')).toHaveCSS('right', '16px')
  await page.getByRole('button', { name: 'AI 대화 최소화', exact: true }).click()
  await page.locator('nori-ai-widget').evaluate(element => {
    element.setAttribute('position', 'bottom-left')
    element.style.setProperty('--nori-ai-width', '200px')
    element.style.setProperty('--nori-ai-height', 'calc(200px + 50px)')
    element.style.setProperty('--nori-ai-accent', '#008000')
  })
  await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
  await expect(panel).toHaveCSS('width', '200px')
  await expect(panel).toHaveCSS('height', '250px')
  await expect(page.locator('.frame')).toHaveCSS('--accent', '#008000')
  await expect(page.locator('nori-ai-widget').locator('.frame')).toHaveCSS('left', '16px')
  await page.getByRole('button', { name: 'AI 대화 최소화', exact: true }).click()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('nori-ai-widget').evaluate(element => {
    element.style.setProperty('--nori-ai-width', '0px')
    element.style.setProperty('--nori-ai-height', 'calc(10px - 20px)')
  })
  await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
  await expect(panel).toHaveCSS('width', '440px')
  await expect(panel).toHaveCSS('height', '600px')
  for (const value of ['//other/api', '/api/../ai', '/api/ai?x=1', '/api/ai#x', '/api/ai/', 'api/ai']) {
    await page.getByRole('button', { name: 'AI 대화 최소화', exact: true }).click()
    await page.locator('nori-ai-widget').evaluate((element, api) => element.setAttribute('api-base', api), value)
    const count = backend.apiRequests.length
    await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
    await expect.poll(() => backend.apiRequests.length).toBeGreaterThan(count)
    await expect(page.getByRole('button', { name: '새 대화', exact: true })).toBeEnabled()
    expect(backend.apiRequests.slice(count).every(request => request.path.startsWith('/api/ai/'))).toBe(true)
  }
})

test('고정 IANA 시계의 context·messages 경로·빈 생성·검증 답변·근거·내보내기', async ({ browser, backend }) => {
  const context = await browser.newContext({ timezoneId: 'Asia/Seoul' })
  try {
    await login(context, backend)
    const page = await context.newPage()
    await page.clock.setFixedTime(new Date('2026-11-23T01:02:03.456Z'))
    await openWidget(page, backend)
    await page.getByRole('button', { name: '새 대화', exact: true }).click()
    await expect.poll(() => backend.conversations.size).toBe(1)
    await expect(questionInput(page)).toBeEnabled()
    const creation = backend.apiRequests.find(request => request.method === 'POST' && request.path.endsWith('/conversations'))
    expect(creation?.body).toBe('')
    const id = [...backend.conversations.keys()][0]
    const jobId = await send(page, backend)
    const query = backend.apiRequests.find(request => request.method === 'POST' && request.path.endsWith('/messages'))
    expect(query?.path).toBe(`/api/ai/v1/conversations/${id}/messages`)
    expect(JSON.parse(query?.body ?? '')).toEqual({ query: '설비 상태를 알려 주세요.', context: { timezone: 'Asia/Seoul', referenceTime: '2026-11-23T10:02:03.456+09:00' } })
    expect(query?.headers['idempotency-key']).toBeTruthy()
    await expect(page.getByRole('button', { name: '보내기', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '취소', exact: true })).toBeEnabled()
    await expect(page.getByRole('log')).toContainText('답변을 기다리고 있습니다.')
    expect(backend.openStreams).toBe(1)
    await expect(page.getByRole('region', { name: '답변', exact: true })).toHaveCount(0)
    backend.event(jobId, 'job.completed', '2')
    await expect(page.getByRole('region', { name: '답변', exact: true })).toContainText('<img src=x onerror=')
    expect(await page.evaluate(() => Reflect.get(window, 'htmlExecuted'))).toBeUndefined()
    await expect(page.locator('nori-ai-widget').locator('img')).toHaveCount(0)
    await reveal(page, '참고 자료 1개')
    await page.getByRole('button', { name: '근거 1', exact: true }).click()
    await expect(page.getByLabel('근거 본문', { exact: true })).toContainText('저장된 근거 본문 <b>문자열</b>')
    await reveal(page, '추가 자료 · 내보내기')
    await page.getByRole('button', { name: '자료 1 내보내기', exact: true }).click()
    await expect(page.getByLabel('내보내기 결과')).toContainText('내보내기 자료')
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('link', { name: '다운로드', exact: true }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('nori-ai-block.json')
    await download.delete()
    backend.failNext({ method: 'GET', path: /\/evidence\/evidence-1\/source$/, status: 403, body: { message: '요청 권한이 없습니다', requestId: 'gateway-request' } })
    await reveal(page, '참고 자료 1개')
    await page.getByRole('button', { name: '근거 1', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('요청 권한이 없습니다')
    await expect(page.getByLabel('근거 본문', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('내보내기 결과')).toHaveCount(0)
    await page.getByRole('button', { name: '대화 목록', exact: true }).click()
    await page.getByRole('button', { name: '설비 상태를 알려 주세요.', exact: true }).click()
    await expect(page.getByRole('region', { name: '대화 내용', exact: true })).toContainText('검증 답변')
    expect(backend.apiRequests.filter(request => /\/analyses\/?(?:\?|$)/.test(request.path))).toEqual([])
  } finally { await context.close() }
})

test('IANA 조회 실패 때 현재 오프셋을 쓰고 새 질문은 query 경로와 새 키를 쓴다', async ({ browser, backend }) => {
  const context = await browser.newContext({ timezoneId: 'America/New_York' })
  try {
    await login(context, backend)
    const page = await context.newPage()
    await page.clock.setFixedTime(new Date('2026-11-23T01:02:03.456Z'))
    await page.goto(backend.origin + '/a')
    // 시계 init script가 적용된 페이지에서 실제 호출 함수를 교체하여 prototype 우회를 피한다.
    const injected = await page.evaluate(() => {
      Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
        apply() { throw new Error('시험용 IANA 실패') },
      })
      try {
        Intl.DateTimeFormat().resolvedOptions()
        return false
      } catch (error) { return error instanceof Error && error.message === '시험용 IANA 실패' }
    })
    expect(injected).toBe(true)
    expect(await page.evaluate(() => new Date().toISOString())).toBe('2026-11-23T01:02:03.456Z')
    await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
    await expect(page.getByRole('button', { name: '새 대화', exact: true })).toBeEnabled()
    const jobId = await send(page, backend, '첫 질문')
    const request = backend.apiRequests.find(row => row.path.endsWith('/query'))
    expect(JSON.parse(request?.body ?? '')).toEqual({ query: '첫 질문', context: { timezone: '-05:00', referenceTime: '2026-11-22T20:02:03.456-05:00' } })
    backend.noEvidence = true
    backend.event(jobId, 'job.completed', '2')
    await expect(page.getByRole('region', { name: '답변', exact: true })).toContainText('근거 없음')
    await expect(page.getByRole('button', { name: '취소', exact: true })).toHaveCount(0)
    await questionInput(page).fill('두 번째 질문')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect.poll(() => backend.jobs.size).toBe(2)
    const requests = backend.apiRequests.filter(row => row.method === 'POST' && /\/(query|messages)$/.test(row.path))
    expect(requests[1]?.path).toContain('/messages')
    expect(requests[1]?.headers['idempotency-key']).not.toBe(requests[0]?.headers['idempotency-key'])
  } finally { await context.close() }
})

for (const mode of ['drop', 'unavailable', 'timeout'] as const) {
  test(`응답 불명 ${mode}: 사용자만 최초 경로·본문·키로 다시 보내고 기존 Job을 받는다`, async ({ page, context, backend }) => {
    await login(context, backend)
    await openWidget(page, backend)
    const failedQueries: string[] = []
    page.on('requestfailed', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/v1/query')) {
        failedQueries.push(request.failure()?.errorText ?? '')
      }
    })
    if (mode === 'drop') {
      // 대역의 실제 접수까지 완료한 뒤 응답을 브라우저에 전달하지 않고 네트워크 오류를 주입한다.
      await page.route('**/api/ai/v1/query', async route => {
        const response = await route.fetch({ maxRetries: 0 })
        try { expect(response.status()).toBe(202) }
        finally {
          try { await route.abort('connectionreset') }
          finally { await response.dispose() }
        }
      }, { times: 1 })
    } else {
      backend.failNext({ method: 'POST', path: /\/query$/, status: mode === 'timeout' ? 504 : 503,
        afterAdmission: true,
        body: { code: mode === 'timeout' ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNAVAILABLE', message: '시험 연결 오류', requestId: 'test-request' } })
    }
    await questionInput(page).fill('응답 불명 표식')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toBeEnabled()
    if (mode === 'drop') {
      await expect.poll(() => failedQueries.length).toBe(1)
      expect(failedQueries[0]).toMatch(/^net::ERR_/)
    }
    expect(backend.jobs.size).toBe(1)
    const posts = () => backend.apiRequests.filter(row => row.method === 'POST' && row.path.endsWith('/query'))
    expect(posts()).toHaveLength(1)
    await page.getByRole('button', { name: '대화 목록', exact: true }).click()
    expect(posts()).toHaveLength(1)
    await page.getByRole('button', { name: '다시 보내기', exact: true }).click()
    await expect(page.getByRole('log')).toContainText('답변을 기다리고 있습니다.')
    expect(posts()).toHaveLength(2)
    expect(posts()[1]?.path).toBe(posts()[0]?.path)
    expect(posts()[1]?.body).toBe(posts()[0]?.body)
    expect(posts()[1]?.headers['idempotency-key']).toBe(posts()[0]?.headers['idempotency-key'])
    expect(backend.jobs.size).toBe(1)
    await expect(page.getByRole('region', { name: '질문 진행', exact: true })).toContainText('답변을 기다리고 있습니다.')
  })
}

for (const status of [409, 404]) {
  test(`재전송 ${status}는 표시하고 최초 키를 유지한다`, async ({ page, context, backend }) => {
    await login(context, backend)
    await openWidget(page, backend)
    backend.failNext({ method: 'POST', path: /\/query$/, status: 504, afterAdmission: true,
      body: { code: 'GATEWAY_TIMEOUT', message: '시험 시간 초과', requestId: 'test-request' } })
    await questionInput(page).fill('재전송 충돌')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toBeEnabled()
    backend.failNext({ method: 'POST', path: /\/query$/, status, body: status === 409 ? { error: 'IDEMPOTENCY_KEY_CONFLICT' } : undefined })
    await page.getByRole('button', { name: '다시 보내기', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText(`HTTP ${status}`)
    if (status === 409) await expect(page.getByRole('alert')).toContainText('IDEMPOTENCY_KEY_CONFLICT')
    await page.getByRole('button', { name: '다시 보내기', exact: true }).click()
    await expect(page.getByRole('log')).toContainText('답변을 기다리고 있습니다.')
    const requests = backend.apiRequests.filter(row => row.method === 'POST' && row.path.endsWith('/query'))
    expect(requests).toHaveLength(3)
    expect(new Set(requests.map(row => row.body)).size).toBe(1)
    expect(new Set(requests.map(row => row.headers['idempotency-key'])).size).toBe(1)
    expect(backend.jobs.size).toBe(1)
  })
}

test('격리 브라우저 공유 목록·불투명 커서·null 제목·다른 사용자 404·204·삭제 후 404', async ({ browser, backend }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()])
  try {
    const [first, second, other] = contexts
    if (!first || !second || !other) throw new Error('브라우저 context가 없습니다.')
    await login(first, backend); await login(second, backend); await login(other, backend, 'bob')
    for (let index = 0; index < 21; index++) backend.seed('alice', index === 20 ? null : `보관 대화 ${index}`)
    const a = await first.newPage(), b = await second.newPage(), c = await other.newPage()
    await openWidget(a, backend); await openWidget(b, backend); await openWidget(c, backend)
    for (const page of [a, b]) {
      await page.getByRole('button', { name: '대화 목록', exact: true }).click()
      await expect(page.getByRole('region', { name: '대화 목록', exact: true }).getByRole('button', { name: '새 대화', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '다음 쪽', exact: true })).toBeVisible()
    }
    await a.getByRole('button', { name: '다음 쪽', exact: true }).click()
    await expect(a.getByRole('button', { name: '보관 대화 0', exact: true })).toBeVisible()
    await expect(a.getByRole('button', { name: '다음 쪽', exact: true })).toHaveCount(0)
    const cursorRequest = backend.apiRequests.find(row => row.path.includes('after='))
    expect(backend.issuedCursors).toContain(new URL(cursorRequest?.path ?? '', backend.origin).searchParams.get('after'))
    const id = [...backend.conversations.keys()][0]
    await c.getByRole('button', { name: '대화 목록', exact: true }).click()
    await expect(c.getByText('대화가 없습니다.', { exact: true })).toBeVisible()
    const denied = await c.evaluate(async path => { const response = await fetch(path); return { status: response.status, body: await response.text() } }, `/api/ai/v1/conversations/${id}`)
    expect(denied).toEqual({ status: 404, body: '' })
    a.once('dialog', dialog => dialog.accept())
    await a.getByRole('button', { name: '보관 대화 0 삭제', exact: true }).click()
    await expect.poll(() => backend.conversations.size).toBe(20)
    await b.getByRole('button', { name: '목록·상세 새로고침', exact: true }).click()
    await expect(b.getByRole('button', { name: '다음 쪽', exact: true })).toHaveCount(0)
    const missing = await b.evaluate(async path => { const response = await fetch(path); return response.status }, `/api/ai/v1/conversations/${id}`)
    expect(missing).toBe(404)
    const storage = await a.evaluate(async () => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), databases: await indexedDB.databases() }))
    expect(storage).toEqual({ local: [], session: [], databases: [] })
  } finally { for (const context of contexts) await context.close() }
})

test('삭제 409는 진행 중 jobId 유무로 안내하며 취소·완료 뒤 재삭제하고 최소화 접수를 보존한다', async ({ browser, backend }) => {
  const first = await browser.newContext(), second = await browser.newContext()
  try {
    await login(first, backend); await login(second, backend)
    const a = await first.newPage(), b = await second.newPage()
    await openWidget(a, backend)
    const jobId = await send(a, backend, '진행 질문')
    await a.getByRole('button', { name: '대화 목록', exact: true }).click()
    a.once('dialog', dialog => dialog.accept())
    await a.getByRole('button', { name: '진행 질문 삭제', exact: true }).click()
    await expect(a.getByRole('alert')).toHaveText('진행 중인 질문을 취소한 뒤 삭제해 주세요.')
    await expect(a.getByRole('button', { name: '취소', exact: true })).toBeEnabled()
    await openWidget(b, backend)
    await b.getByRole('button', { name: '대화 목록', exact: true }).click()
    b.once('dialog', dialog => dialog.accept())
    await b.getByRole('button', { name: '진행 질문 삭제', exact: true }).click()
    await expect(b.getByRole('alert')).toHaveText('진행 중인 질문이 끝난 뒤 다시 삭제해 주세요.')
    await expect.poll(() => backend.apiRequests.filter(row => row.path.endsWith(`/conversations/${backend.jobs.get(jobId)?.accepted.conversationId}`) && row.method === 'GET').length).toBeGreaterThan(0)
    await a.getByRole('button', { name: 'AI 대화 최소화', exact: true }).click()
    await a.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
    await expect(a.getByRole('region', { name: '질문 진행', exact: true })).toHaveCount(1)
    a.once('dialog', dialog => dialog.accept())
    await a.getByRole('button', { name: '진행 질문 삭제', exact: true }).click()
    await expect(a.getByRole('alert')).toHaveText('진행 중인 질문을 취소한 뒤 삭제해 주세요.')
    await expect(a.getByRole('button', { name: '취소', exact: true })).toBeEnabled()
    // 최소화한 창은 원래 접수한 작업을 유지하며 다른 창에서도 종결을 확인한다.
    backend.event(jobId, 'job.completed', '2')
    b.once('dialog', dialog => dialog.accept())
    await b.getByRole('button', { name: '진행 질문 삭제', exact: true }).click()
    await expect.poll(() => backend.conversations.size).toBe(0)
    await a.getByRole('button', { name: 'AI 대화 최소화', exact: true }).click()
    await a.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
    await expect(a.getByRole('button', { name: '새 대화', exact: true })).toBeEnabled()
    await send(a, backend, '취소 질문')
    await expect(a.getByRole('complementary')).toBeVisible()
    await a.getByRole('button', { name: '취소', exact: true }).click()
    await expect(a.getByRole('button', { name: '취소', exact: true })).toHaveCount(0)
    await expect(a.getByText('취소를 요청했습니다.', { exact: true })).toBeVisible()
    a.once('dialog', dialog => dialog.accept())
    await a.getByRole('button', { name: '취소 질문 삭제', exact: true }).click()
    await expect.poll(() => backend.conversations.size).toBe(0)
    await a.getByRole('button', { name: 'AI 대화 최소화', exact: true }).click()
    await a.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
    await expect(a.getByRole('region', { name: '질문 진행', exact: true })).toHaveCount(0)
    await expect(a.getByRole('region', { name: '대화 내용', exact: true })).toHaveText('')
    expect(backend.apiRequests.filter(row => /\/analyses(?:\?|$)/.test(row.path))).toEqual([])
  } finally { await first.close(); await second.close() }
})
