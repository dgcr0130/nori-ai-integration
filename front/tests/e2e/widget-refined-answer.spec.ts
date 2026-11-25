import { test, expect, login, openWidget, send } from './backend'

test('A-UI2 처리중에는 진행 확인 accordion 없이 간단한 진행만 표시한다', async ({ page, context, backend }) => {
  await login(context, backend); await openWidget(page, backend)
  await send(page, backend)
  const progress = page.getByRole('region', { name: '질문 진행', exact: true })
  await expect(progress.locator('summary')).toHaveCount(0)
  await expect(progress.getByRole('log')).toContainText('답변을 기다리고 있습니다.')
})

test('A-UI2 종결 결과 대기·실패는 완료 장식 없이 조회 상태와 직접 복구를 제공한다', async ({ page, context, backend }) => {
  await login(context, backend); await openWidget(page, backend)
  const id = await send(page, backend)
  let release = () => {}, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/v1/analyses/${id}`, async route => {
    started = true; await held; await route.fulfill({ status: 500, json: { message: '결과 조회 실패' } })
  }, { times: 1 })
  try {
    backend.event(id, 'job.partial', '2'); await expect.poll(() => started).toBe(true)
    const progress = page.getByRole('region', { name: '질문 진행', exact: true })
    await expect(progress).not.toContainText('일부 답변이 완료되었습니다.')
    await expect(progress).toContainText('답변을 불러오고 있습니다.')
    await expect(progress.locator('summary')).toHaveCount(0)
    release()
    await expect(page.getByRole('alert')).toHaveText('결과 조회 실패')
    await expect(page.getByRole('button', { name: '결과 다시 조회', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '결과 다시 조회', exact: true }).click()
    await expect(page.getByRole('region', { name: '답변', exact: true })).toContainText('검증 답변')
    await expect(progress).toHaveCount(0)
  } finally { release() }
})

test('A 완료 답변은 본문·의견 진입점만 표시하고 생성 인용만 투영한다', async ({ page, context, backend }) => {
  await login(context, backend); await openWidget(page, backend)
  const jobId = await send(page, backend)
  await page.route(`**/v1/analyses/${jobId}`, route => route.fulfill({ json: {
    jobId, jobStatus: 'SUCCEEDED', resultAccess: 'ALLOWED', result: { payload: {
      answer: { kind: 'ANSWER', text: '배열 [1], 포트 6100, 버전 26.07.11.0000입니다.[1]\n\n직접 표\n값: 6100',
        sentences: [{ text: '배열 [1], 포트 6100, 버전 26.07.11.0000입니다.', citations: [1] }],
        citations: [{ number: 1, evidenceId: 'e1', sourceType: 'DOCUMENT', title: '안내' }] },
      blocks: [{ id: 'help', type: 'table', content: { rows: [{ description: '별도 기능 목록' }] } }],
    } },
  } }))
  backend.event(jobId, 'job.completed', '2')
  const answer = page.getByRole('region', { name: '답변', exact: true })
  await expect(answer.locator('.answer-text')).toHaveText('배열 [1], 포트 6100, 버전 26.07.11.0000입니다.\n\n직접 표\n값: 6100')
  await expect(answer.locator('summary')).toHaveText(['의견 남기기'])
  await expect(answer.getByRole('button', { name: '도움이 됨', exact: true })).toBeHidden()
  await expect(page.getByRole('region', { name: '질문 진행', exact: true })).toHaveCount(0)
  expect(backend.apiRequests.filter(row => /evidence|export/.test(row.path))).toHaveLength(0)
})

for (const body of ['일부 자료를 확인할 수 없습니다.', '최신 자료가 아닐 수 있습니다.', '서로 맞지 않는 자료가 있어 하나로 확정할 수 없습니다.', '확인한 내용만 답변합니다.']) {
  test(`A 실제 부족 의미를 한곳에 보존: ${body}`, async ({ page, context, backend }) => {
    await login(context, backend); await openWidget(page, backend)
    const jobId = await send(page, backend)
    await page.route(`**/v1/analyses/${jobId}`, route => route.fulfill({ json: {
      jobId, jobStatus: 'SUCCEEDED', resultAccess: 'ALLOWED', result: { payload: {
        answer: { kind: 'PARTIAL', text: body, sentences: [], citations: [] }, blocks: [],
      } },
    } }))
    backend.event(jobId, 'job.partial', '2')
    const answer = page.getByRole('region', { name: '답변', exact: true })
    await expect(answer).toContainText(body)
    await expect(answer).not.toContainText('일부 답변이 완료되었습니다.')
    await expect(answer).toContainText(body.includes('확인한 내용') ? '일부 자료를 확인할 수 없습니다.' : body)
    await expect(answer.locator('summary')).toHaveText(['의견 남기기'])
  })
}

test('A 종결 뒤 결과 GET 실패는 복구하고 정상 본문 도착 후 진행을 닫는다', async ({ page, context, backend }) => {
  await login(context, backend); await openWidget(page, backend)
  const id = await send(page, backend)
  backend.failNext({ method: 'GET', path: new RegExp(`/analyses/${id}$`), status: 500, body: { message: '결과 조회 실패' } })
  backend.event(id, 'job.completed', '2')
  await expect(page.getByRole('alert')).toHaveText('결과 조회 실패')
  await expect(page.getByRole('region', { name: '질문 진행', exact: true }).locator('summary')).toHaveCount(0)
  await page.getByRole('button', { name: '결과 다시 조회', exact: true }).click()
  await expect(page.getByRole('region', { name: '답변', exact: true })).toContainText('검증 답변')
  await expect(page.getByRole('region', { name: '질문 진행', exact: true })).toHaveCount(0)
  expect(backend.apiRequests.filter(row => row.path === `/api/ai/v1/analyses/${id}`)).toHaveLength(2)
})

for (const status of [200, 403, 404]) test(`A 다른 대화 선택 뒤 늦은 종결 결과 ${status}는 폐기한다`, async ({ page, context, backend }) => {
  backend.seed('alice', '다른 대화')
  await login(context, backend); await openWidget(page, backend)
  const id = await send(page, backend)
  let release = () => {}, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/v1/analyses/${id}`, async route => {
    started = true; await held
    if (status === 200) await route.continue()
    else await route.fulfill({ status, json: { message: '이전 결과 접근 실패' } })
  })
  try {
    backend.event(id, 'job.completed', '2'); await expect.poll(() => started).toBe(true)
    await page.getByRole('button', { name: '대화 목록', exact: true }).click()
    await page.getByRole('button', { name: '다른 대화', exact: true }).click()
    await expect(page.locator('.message-user')).toHaveCount(0)
    release()
    await page.unrouteAll({ behavior: 'wait' })
    await expect(page.getByRole('region', { name: '답변', exact: true })).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally { release() }
})

test('A 다른 대화 삭제는 현재 대화의 종결 결과를 버리지 않는다', async ({ page, context, backend }) => {
  backend.seed('alice', '삭제할 다른 대화')
  await login(context, backend); await openWidget(page, backend)
  const id = await send(page, backend)
  let release = () => {}, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/v1/analyses/${id}`, async route => { started = true; await held; await route.continue() })
  try {
    backend.event(id, 'job.completed', '2'); await expect.poll(() => started).toBe(true)
    await page.getByRole('button', { name: '대화 목록', exact: true }).click()
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: '삭제할 다른 대화 삭제', exact: true }).click()
    await expect(page.getByRole('button', { name: '삭제할 다른 대화 삭제', exact: true })).toHaveCount(0)
    release()
    await expect(page.getByRole('region', { name: '답변', exact: true })).toContainText('검증 답변')
  } finally { release() }
})

test('A 의견의 평가·입력·접수 결과는 같은 접힘 영역에만 있다', async ({ page, context, backend }) => {
  await login(context, backend); await openWidget(page, backend)
  const id = await send(page, backend); backend.event(id, 'job.completed', '2')
  const feedback = page.getByRole('region', { name: '피드백', exact: true })
  await expect(feedback.getByRole('button', { name: '도움이 됨', exact: true })).toBeHidden()
  await feedback.locator('summary').click()
  await feedback.getByRole('textbox', { name: '지적', exact: true }).fill('의견')
  await feedback.getByRole('button', { name: '도움이 됨', exact: true }).click()
  await expect(feedback.getByRole('status')).toContainText('접수되었습니다.')
  await feedback.locator('summary').click()
  await expect(feedback.getByRole('status')).toBeHidden()
  expect(backend.apiRequests.filter(row => row.method === 'PUT' && row.path.endsWith('/feedback'))).toHaveLength(1)
})
