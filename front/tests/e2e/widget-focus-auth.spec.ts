import { test, expect, login, openWidget, questionInput, send } from './backend'
import { reveal } from './redesign-helpers'

test('일반 focus의 지연 인증 중 대화 DOM·초안·두 스크롤·누적 목록을 유지한다', async ({ page, context, backend }) => {
  for (let index = 0; index < 45; index++) backend.seed('alice', `보존 대화 ${index}`)
  const id = [...backend.conversations.keys()].at(-1)!
  backend.conversations.get(id)!.messages.push({ messageId: 'long', role: 'assistant', content: '읽던 본문\n'.repeat(150) })
  await login(context, backend); await openWidget(page, backend)
  await page.getByRole('button', { name: '대화 목록', exact: true }).click()
  await page.getByRole('button', { name: '보존 대화 44', exact: true }).click()
  await questionInput(page).fill('유지할 초안')
  const aside = page.getByRole('complementary')
  await aside.evaluate(node => { node.scrollTop = node.scrollHeight })
  await expect(page.locator('.conversation-row')).toHaveCount(40)
  await aside.evaluate(node => { node.scrollTop = 80 })
  await page.locator('main').evaluate(node => { node.scrollTop = 120 })
  const input = await questionInput(page).elementHandle()
  const before = await page.locator('main').evaluate(node => node.scrollTop)
  const sideBefore = await aside.evaluate(node => node.scrollTop)
  const requests = backend.apiRequests.length
  let release = () => {}, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/session', async route => { started = true; await held; await route.continue() })
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => started).toBe(true)
    expect(await input!.evaluate(node => node.isConnected)).toBe(true)
    await expect(questionInput(page)).toHaveValue('유지할 초안')
    await questionInput(page).fill('확인 중에도 쓰는 초안')
    await expect(page.getByRole('button', { name: '보내기', exact: true })).toBeDisabled()
    await expect(page.locator('.conversation-row')).toHaveCount(40)
    expect(await page.locator('main').evaluate(node => node.scrollTop)).toBe(before)
    expect(await aside.evaluate(node => node.scrollTop)).toBe(sideBefore)
    release()
    await expect(page.getByRole('button', { name: '보내기', exact: true })).toBeEnabled()
    expect(await input!.evaluate(node => node.isConnected)).toBe(true)
    await expect(questionInput(page)).toHaveValue('확인 중에도 쓰는 초안')
    await expect(page.locator('.conversation-row')).toHaveCount(40)
    expect(await page.locator('main').evaluate(node => node.scrollTop)).toBe(before)
    expect(await aside.evaluate(node => node.scrollTop)).toBe(sideBefore)
    expect(backend.apiRequests.slice(requests).filter(row => row.method === 'POST')).toHaveLength(0)
    expect(backend.apiRequests.slice(requests).filter(row => row.path.includes('/conversations?'))).toHaveLength(0)
    expect(backend.jobs.size).toBe(0)
  } finally { release(); await input?.dispose() }
})

test('정상 focus는 열린 자료·피드백 초안을 유지하고 활성 SSE를 교체하거나 질문을 재접수하지 않는다', async ({ page, context, backend }) => {
  await login(context, backend); await openWidget(page, backend)
  const job = await send(page, backend)
  await expect.poll(() => backend.openStreams).toBe(1)
  const streams = backend.apiRequests.filter(row => row.path.endsWith('/events')).length
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('button', { name: '새 대화', exact: true })).toBeDisabled()
  backend.event(job, 'job.started', '1')
  await expect(page.getByRole('log')).toContainText('준비')
  expect(backend.openStreams).toBe(1)
  expect(backend.apiRequests.filter(row => row.path.endsWith('/events'))).toHaveLength(streams)
  expect(backend.jobs.size).toBe(1)
  backend.event(job, 'job.completed', '2')
  await expect(page.getByRole('region', { name: '답변', exact: true })).toBeVisible()
  await reveal(page, '참고 자료 1개'); await reveal(page, '의견 남기기')
  await page.getByRole('textbox', { name: '지적', exact: true }).fill('피드백 초안')
  await page.getByRole('button', { name: '[1] 설비 등록 정보', exact: true }).click()
  await expect(page.getByLabel('근거 1 본문', { exact: true })).toBeVisible()
  const details = await page.locator('details.sources').filter({ hasText: '참고 자료 1개' }).elementHandle()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('button', { name: '[1] 설비 등록 정보', exact: true })).toBeEnabled()
  expect(await details!.evaluate(node => node.isConnected && node instanceof HTMLDetailsElement && node.open)).toBe(true)
  await expect(page.getByRole('textbox', { name: '지적', exact: true })).toHaveValue('피드백 초안')
  await expect(page.getByLabel('근거 1 본문', { exact: true })).toBeVisible()
  expect(backend.apiRequests.filter(row => row.method === 'POST' && /query|messages/.test(row.path))).toHaveLength(1)
  await details?.dispose()
})

for (const failure of ['503', 'transport', 'invalid', 'empty-subject', 'invalid-csrf'] as const) {
  for (const account of ['alice', 'bob']) {
    test(`인증 ${failure} 뒤 ${account} 복구는 보호 메모리를 신원에 결속하고 자동 전송하지 않는다`, async ({ page, context, backend }) => {
      await login(context, backend); await openWidget(page, backend)
      const job = await send(page, backend)
      await expect.poll(() => backend.openStreams).toBe(1)
      let fail = true
      await page.route('**/session', async route => {
        if (!fail) return route.continue()
        fail = false
        if (failure === 'transport') return route.abort('failed')
        if (failure === '503') return route.fulfill({ status: 503, json: { code: 'AUTH_UNAVAILABLE', message: '인증 확인 불가' } })
        return route.fulfill({ json: failure === 'invalid' ? { subject: 'alice', canReview: 'wrong' }
          : { subject: failure === 'empty-subject' ? '' : 'alice', canReview: true, integrationVersion: '1.0.4',
            csrf: failure === 'invalid-csrf' ? { headerName: '', token: 'invalid' } : null } })
      })
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(page.getByRole('region', { name: '대화 내용', exact: true })).toHaveCount(0)
      await expect.poll(() => backend.openStreams).toBe(0)
      await login(context, backend, account)
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect(questionInput(page)).toBeVisible()
      await expect(page.locator('.message-user')).toHaveCount(account === 'alice' ? 1 : 0)
      await expect(page.getByRole('button', { name: '다시 연결', exact: true })).toHaveCount(account === 'alice' ? 1 : 0)
      expect(backend.jobs.size).toBe(1)
      expect([...backend.jobs.keys()]).toEqual([job])
      expect(backend.apiRequests.filter(row => row.method === 'POST' && /query|messages/.test(row.path))).toHaveLength(1)
    })
  }
}

for (const status of [403, 404, 'DENIED'] as const) {
  test(`일반 focus의 동일 사용자 ${status} 회수는 답변·초안·근거를 제거한다`, async ({ page, context, backend }) => {
    await login(context, backend); await openWidget(page, backend)
    const job = await send(page, backend)
    backend.event(job, 'job.completed', '2')
    await expect(page.getByRole('region', { name: '답변', exact: true })).toBeVisible()
    await questionInput(page).fill('회수할 초안')
    const id = backend.jobs.get(job)!.accepted.conversationId
    if (status === 'DENIED') {
      const messages = backend.conversations.get(id)!.messages
      const result = messages.find(message => message.role === 'assistant')!.content
      if (typeof result === 'string') throw new Error('시험 결과 누락')
      result.resultAccess = 'DENIED'
    } else backend.failNext({ method: 'GET', path: new RegExp(`/conversations/${id}$`), status, body: { message: '접근 회수' } })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByRole('region', { name: '답변', exact: true })).toHaveCount(0)
    await expect(questionInput(page)).toHaveValue('')
    await expect(page.getByLabel('근거 1 본문', { exact: true })).toHaveCount(0)
  })
}

test('focus 검토 version 변경은 구 초안을 새 version에 자동 결속하지 않는다', async ({ page, context, backend }) => {
  backend.reviewers.add('alice')
  const id = backend.seedReview()
  await login(context, backend); await openWidget(page, backend)
  await page.getByRole('button', { name: '검토', exact: true }).click()
  await page.getByRole('button', { name: /^검토 항목/ }).click()
  await page.getByRole('textbox', { name: '조치 메모', exact: true }).fill('이전 버전 초안')
  backend.feedbacks.get(id)!.detail.feedback.version = 2
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('textbox', { name: '조치 메모', exact: true })).toHaveValue('')
  expect(backend.apiRequests.filter(row => row.path.endsWith('/resolve'))).toHaveLength(0)
  backend.reviewers.delete('alice')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('button', { name: '검토', exact: true })).toHaveCount(0)
})

test('접수 응답 대기 중 인증 불가는 같은 멱등 키의 명시 재시도만 보존한다', async ({ page, context, backend }) => {
  await login(context, backend); await openWidget(page, backend)
  let release = () => {}, admitted = false
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/v1/query', async route => {
    if (admitted) return route.continue()
    const response = await route.fetch()
    admitted = true; await held
    await route.fulfill({ response })
  })
  try {
  await questionInput(page).fill('접수 응답 불명 질문')
  await page.getByRole('button', { name: '보내기', exact: true }).click()
  await expect.poll(() => backend.jobs.size).toBe(1)
  backend.failNext({ method: 'GET', path: /\/session$/, status: 503, body: { code: 'AUTH_UNAVAILABLE', message: '인증 확인 불가' } })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(questionInput(page)).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toBeEnabled()
  const posts = () => backend.apiRequests.filter(row => row.method === 'POST' && row.path.endsWith('/query'))
  expect(posts()).toHaveLength(1)
  await page.getByRole('button', { name: '다시 보내기', exact: true }).click()
  await expect.poll(() => posts().length).toBe(2)
  expect(posts()[0]!.headers['idempotency-key']).toBe(posts()[1]!.headers['idempotency-key'])
  expect(posts()[0]!.body).toBe(posts()[1]!.body)
  expect(backend.jobs.size).toBe(1)
  } finally { release() }
})

test('동기 인증 무효화는 최소화·늦은 세션 성공을 무시하고 서버 확인 후 새 CSRF만 적용한다', async ({ page, context, backend }) => {
  await login(context, backend); await openWidget(page, backend)
  await questionInput(page).fill('로그아웃 전 초안')
  let release = () => {}, started = false, finished = false
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/session', async route => {
    if (started) return route.continue()
    started = true; await held
    await route.fulfill({ json: { subject: 'alice', canReview: true, integrationVersion: '1.0.4', csrf: { headerName: 'X-Nori-AI-CSRF', token: 'stale' } } })
    finished = true
  })
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => started).toBe(true)
    await page.getByRole('button', { name: 'AI 대화 최소화', exact: true }).click()
    await page.evaluate(() => {
      Reflect.set(window, 'noriAiAuthState', 'signed-out')
      window.dispatchEvent(new Event('nori-ai-auth-change'))
    })
    release(); await expect.poll(() => finished).toBe(true)
    await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('로그인이 필요합니다.')
    await expect(questionInput(page)).toHaveCount(0)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(questionInput(page)).toHaveCount(0)
    await login(context, backend, 'bob')
    await page.evaluate(() => {
      Reflect.set(window, 'noriAiAuthState', 'check')
      window.dispatchEvent(new Event('nori-ai-auth-change'))
    })
    await expect(questionInput(page)).toHaveValue('')
    const job = await send(page, backend, '새 사용자 질문')
    expect(backend.jobs.get(job)!.subject).toBe('bob')
    expect(backend.apiRequests.find(row => row.method === 'POST' && row.path.endsWith('/query'))?.headers['x-nori-ai-csrf']).toBe('fake-csrf')
  } finally { release() }
})

test('늦게 연결된 위젯도 호스트 로그아웃을 먼저 읽으며 잘못된 통지로 인증하지 않는다', async ({ page, context, backend }) => {
  await login(context, backend)
  await page.addInitScript(() => Reflect.set(window, 'noriAiAuthState', 'signed-out'))
  await page.goto(backend.origin + '/a')
  await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('로그인이 필요합니다.')
  expect(backend.apiRequests).toHaveLength(0)
  await page.evaluate(() => {
    Reflect.set(window, 'noriAiAuthState', { subject: 'alice', canReview: true, csrf: 'forged' })
    window.dispatchEvent(new Event('nori-ai-auth-change'))
    window.dispatchEvent(new Event('focus'))
  })
  await expect(questionInput(page)).toHaveCount(0)
  expect(backend.apiRequests).toHaveLength(0)
  await page.evaluate(() => {
    Reflect.set(window, 'noriAiAuthState', 'check')
    window.dispatchEvent(new Event('nori-ai-auth-change'))
  })
  await expect(questionInput(page)).toBeEnabled()
  expect(backend.apiRequests.some(row => row.path.endsWith('/session'))).toBe(true)
  await expect(page.getByRole('button', { name: '검토', exact: true })).toHaveCount(0)
})

test('focus가 진행 중 검토의 새 version을 확인하면 늦은 제출 응답이 양식·busy를 되살리지 않는다', async ({ page, context, backend }) => {
  backend.reviewers.add('alice')
  const id = backend.seedReview()
  await login(context, backend); await openWidget(page, backend)
  await page.getByRole('button', { name: '검토', exact: true }).click()
  await page.getByRole('button', { name: /^검토 항목/ }).click()
  await page.getByRole('combobox', { name: '원인', exact: true }).selectOption('REJECT')
  await page.getByRole('textbox', { name: '조치 메모', exact: true }).fill('검토 반려 사유')
  let release = () => {}, started = false, finished = false
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/resolve', async route => {
    const response = await route.fetch()
    started = true; await held
    await route.fulfill({ response }); finished = true
  })
  try {
    await page.getByRole('button', { name: '조치 제출', exact: true }).click()
    await expect.poll(() => started).toBe(true)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByRole('button', { name: '검토', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '조치 제출', exact: true })).toHaveCount(0)
    release(); await expect.poll(() => finished).toBe(true)
    await expect(page.getByRole('button', { name: '검토', exact: true })).toBeEnabled()
    expect(backend.apiRequests.filter(row => row.path.endsWith('/resolve'))).toHaveLength(1)
    expect(backend.feedbacks.get(id)!.detail.feedback.version).toBe(2)
  } finally { release() }
})

test('FOCUS-R1 미처리 검토 제출은 같은 version focus 뒤에도 busy와 단일 POST를 유지한다', async ({ page, context, backend }) => {
  backend.reviewers.add('alice')
  const id = backend.seedReview()
  await login(context, backend); await openWidget(page, backend)
  await page.getByRole('button', { name: '검토', exact: true }).click()
  await page.getByRole('button', { name: /^검토 항목/ }).click()
  await page.getByRole('combobox', { name: '원인', exact: true }).selectOption('REJECT')
  await page.getByRole('textbox', { name: '조치 메모', exact: true }).fill('처리 중 중복 금지')
  let release = () => {}, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/resolve', async route => { started = true; await held; await route.continue() })
  try {
    const submit = page.getByRole('button', { name: '조치 제출', exact: true })
    await submit.click(); await expect.poll(() => started).toBe(true)
    await expect(submit).toBeDisabled()
    const detail = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/reviews/' + id))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await (await detail).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(backend.feedbacks.get(id)!.detail.feedback.version).toBe(1)
    await expect(submit).toBeDisabled()
    await expect(page.getByRole('button', { name: '검토', exact: true })).toBeDisabled()
    release()
    await expect(page.getByRole('region', { name: '검토 상세', exact: true })).toContainText('2차')
    await expect(submit).toHaveCount(0)
    await expect(page.getByRole('button', { name: '검토', exact: true })).toBeEnabled()
    expect(backend.apiRequests.filter(row => row.path.endsWith('/resolve'))).toHaveLength(1)
  } finally { release() }
})

for (const lateFailure of [false, true]) {
  test(`FOCUS-R1 POST 완료 뒤 같은 version의 늦은 focus GET ${lateFailure ? '403' : '성공'}은 새 상세를 덮지 않는다`, async ({ page, context, backend }) => {
    backend.reviewers.add('alice')
    const id = backend.seedReview()
    await login(context, backend); await openWidget(page, backend)
    await page.getByRole('button', { name: '검토', exact: true }).click()
    await page.getByRole('button', { name: /^검토 항목/ }).click()
    await page.getByRole('combobox', { name: '원인', exact: true }).selectOption('REJECT')
    await page.getByRole('textbox', { name: '조치 메모', exact: true }).fill('역순 응답 보호')
    let releasePost = () => {}, postStarted = false, releaseGet = () => {}, getStarted = false, getFinished = false
    const heldPost = new Promise<void>(resolve => { releasePost = resolve })
    const heldGet = new Promise<void>(resolve => { releaseGet = resolve })
    await page.route('**/resolve', async route => { postStarted = true; await heldPost; await route.continue() })
    await page.route('**/reviews/' + id, async route => {
      if (getStarted) return route.continue()
      const response = await route.fetch()
      expect((await response.json()).feedback.version).toBe(1)
      getStarted = true; await heldGet
      await route.fulfill(lateFailure ? { status: 403, json: { code: 'REVIEW_FORBIDDEN', message: '이전 요청 거절' } } : { response })
      getFinished = true
    })
    try {
      await page.getByRole('button', { name: '조치 제출', exact: true }).click()
      await expect.poll(() => postStarted).toBe(true)
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect.poll(() => getStarted).toBe(true)
      releasePost()
      await expect(page.getByRole('region', { name: '검토 상세', exact: true })).toContainText('2차')
      releaseGet(); await expect.poll(() => getFinished).toBe(true)
      await expect(page.getByRole('region', { name: '검토 상세', exact: true })).toContainText('2차')
      await expect(page.getByRole('button', { name: '조치 제출', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '검토', exact: true })).toBeEnabled()
      expect(backend.apiRequests.filter(row => row.path.endsWith('/resolve'))).toHaveLength(1)
    } finally { releasePost(); releaseGet() }
  })
}
