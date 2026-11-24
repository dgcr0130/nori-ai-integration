import type { Page } from '@playwright/test'
import { test, expect, login, openWidget } from './backend'

const rows = (page: Page) => page.getByRole('region', { name: '대화 목록', exact: true }).locator('.conversation-row')
const sidebar = (page: Page) => page.getByRole('complementary', { name: '대화 사이드바', exact: true })
async function bottom(page: Page): Promise<void> {
  await sidebar(page).hover()
  await page.mouse.wheel(0, 3000)
}
async function painted(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

test('대화 연속 스크롤은 실제 aside에서 세 페이지를 누적하고 끝에서 멈춘다', async ({ page, context, backend }) => {
  for (let index = 0; index < 45; index++) backend.seed('alice', `스크롤 대화 ${index}`)
  await login(context, backend); await openWidget(page, backend)
  const requests = () => backend.apiRequests.filter(row => row.path.includes('/conversations?'))
  await painted(page)
  expect(requests()).toHaveLength(1)
  await page.getByRole('button', { name: '대화 목록', exact: true }).click()
  await expect(rows(page)).toHaveCount(20)
  await bottom(page)
  await expect(rows(page)).toHaveCount(40)
  await bottom(page)
  await expect(rows(page)).toHaveCount(45)
  await expect(page.getByRole('button', { name: '스크롤 대화 44', exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '스크롤 대화 0', exact: true })).toBeVisible()
  await expect(sidebar(page).getByRole('button', { name: /다음 쪽|이전 쪽/ })).toHaveCount(0)
  await bottom(page); await painted(page)
  expect(requests()).toHaveLength(3)
  const cursors = requests().slice(1).map(row => new URL(row.path, backend.origin).searchParams.get('after'))
  expect(new Set(cursors).size).toBe(2)
  expect(cursors.every(cursor => backend.issuedCursors.includes(cursor ?? ''))).toBe(true)
})

test('짧은 목록도 보일 때 이어 읽으며 중복 항목과 반복 커서를 종료한다', async ({ page, context, backend }) => {
  const entry = { id: 'first', title: '첫 대화' }
  let requests = 0
  await page.route('**/v1/conversations?*', async route => {
    requests++
    await route.fulfill({ json: requests === 1 ? { items: [entry], nextAfter: 'opaque+cursor/=' }
      : { items: [entry, { id: 'second', title: '둘째 대화' }, entry], nextAfter: 'opaque+cursor/=' } })
  })
  await login(context, backend); await openWidget(page, backend)
  await painted(page); expect(requests).toBe(1)
  await page.getByRole('button', { name: '대화 목록', exact: true }).click()
  await expect(rows(page)).toHaveCount(2)
  await expect(page.getByRole('button', { name: '첫 대화', exact: true })).toHaveCount(1)
  await bottom(page); await painted(page)
  expect(requests).toBe(2)
})

test('후속 조회 중복을 막고 오류 후 자동 반복 없이 명시적으로 재시도한다', async ({ page, context, backend }) => {
  for (let index = 0; index < 21; index++) backend.seed('alice', `재시도 대화 ${index}`)
  let attempts = 0
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/v1/conversations?*', async route => {
    if (!new URL(route.request().url()).searchParams.has('after')) { await route.continue(); return }
    attempts++
    if (attempts === 1) { await held; await route.fulfill({ status: 503, json: { message: '목록 연결 오류' } }) }
    else await route.continue()
  })
  try {
    await login(context, backend); await openWidget(page, backend)
    await page.getByRole('button', { name: '대화 목록', exact: true }).click()
    await bottom(page); await expect.poll(() => attempts).toBe(1)
    await bottom(page); await bottom(page); await painted(page)
    expect(attempts).toBe(1)
    release()
    await expect(page.getByRole('alert')).toContainText('목록 연결 오류')
    await bottom(page); await painted(page)
    expect(attempts).toBe(1)
    await expect(rows(page)).toHaveCount(20)
    await page.getByRole('button', { name: '목록 다시 시도', exact: true }).click()
    await expect(rows(page)).toHaveCount(21)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(attempts).toBe(2)
  } finally { release() }
})

for (const lateFailure of [false, true]) {
  test(`새로고침 뒤 늦은 후속 ${lateFailure ? '오류는' : '응답은'} 새 목록을 바꾸지 않는다`, async ({ page, context, backend }) => {
    for (let index = 0; index < 21; index++) backend.seed('alice', `이전 대화 ${index}`)
    let release = () => {}, started = false, finished = false
    const held = new Promise<void>(resolve => { release = resolve })
    await page.route('**/v1/conversations?*', async route => {
      if (started || !new URL(route.request().url()).searchParams.has('after')) { await route.continue(); return }
      started = true
      await held
      await route.fulfill(lateFailure ? { status: 503, json: { message: '오래된 목록 오류' } }
        : { json: { items: [{ id: 'stale', title: '늦은 대화' }], nextAfter: null } })
      finished = true
    })
    try {
      await login(context, backend); await openWidget(page, backend)
      await page.getByRole('button', { name: '대화 목록', exact: true }).click()
      await bottom(page); await expect.poll(() => started).toBe(true)
      backend.seed('alice', '새로고침 대화')
      await page.getByRole('button', { name: '목록·상세 새로고침', exact: true }).click()
      await expect(page.getByRole('button', { name: '새로고침 대화', exact: true })).toHaveCount(1)
      release(); await expect.poll(() => finished).toBe(true); await painted(page)
      expect(await rows(page).count()).toBeGreaterThanOrEqual(20)
      await expect(page.getByRole('button', { name: '새로고침 대화', exact: true })).toHaveCount(1)
      await expect(page.getByText('늦은 대화', { exact: true })).toHaveCount(0)
      await expect(page.getByText('오래된 목록 오류', { exact: true })).toHaveCount(0)
    } finally { release() }
  })
}

test('사용자 전환 뒤 이전 사용자 후속 응답을 섞지 않는다', async ({ page, context, backend }) => {
  for (let index = 0; index < 21; index++) backend.seed('alice', `이전 사용자 ${index}`)
  backend.seed('bob', '다른 사용자 대화')
  let release = () => {}, started = false
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/v1/conversations?*', async route => {
    if (!new URL(route.request().url()).searchParams.has('after')) { await route.continue(); return }
    started = true
    await held
    await route.fulfill({ json: { items: [{ id: 'old-user', title: '이전 사용자 늦은 대화' }], nextAfter: null } })
  })
  try {
    await login(context, backend); await openWidget(page, backend)
    await page.getByRole('button', { name: '대화 목록', exact: true }).click()
    await bottom(page); await expect.poll(() => started).toBe(true)
    await login(context, backend, 'bob')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByRole('button', { name: '새 대화', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '대화 목록', exact: true }).click()
    await expect(page.getByRole('button', { name: '다른 사용자 대화', exact: true })).toBeVisible()
    release(); await painted(page)
    await expect(rows(page)).toHaveCount(1)
    await expect(page.getByText(/이전 사용자/)).toHaveCount(0)
  } finally { release() }
})
