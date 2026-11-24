import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { ConsumerApp, widgetDigest } from './consumer-fixtures'
import { object, text } from '../../src/api'

test('두 실제 Boot 소비 앱에서 같은 위젯·서명·내부 도구·React 격리를 연결한다', async ({ browser }) => {
  test.setTimeout(0)
  const apps = [new ConsumerApp('cookie'), new ConsumerApp('header')]
  const contexts = []
  const queries: string[] = []
  try {
    const digest = await widgetDigest()
    for (const app of apps) {
      await app.start()
      const context = await browser.newContext()
      contexts.push(context)
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const prefix = app.mode === 'cookie' ? '/api/ai' : '/prefix/api/ai'
      const asset = await context.request.get(app.origin + prefix + '/assets/widget.js')
      expect(asset.status()).toBe(200)
      expect(createHash('sha256').update(await asset.body()).digest('hex')).toBe(digest)
      expect((await context.request.get(app.origin + prefix + '/session')).status()).toBe(401)
      if (app.mode === 'cookie') {
        await page.goto(app.origin + '/login')
        await page.locator('[name="username"]').fill('reader_1')
        await page.locator('[name="password"]').fill(app.login)
        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        await page.waitForURL(app.origin + '/')
      } else await page.goto(app.origin)
      await expect(page.getByRole('heading', { name: app.mode === 'cookie' ? '쿠키 호스트 React 19.2.8' : '헤더 호스트 React 18.3.1' })).toBeVisible()
      const widget = page.locator('nori-ai-widget')
      await expect(widget).toHaveCount(1)
      await expect.poll(() => widget.evaluate(element => Reflect.get(element, 'integrationVersion'))).toBe('1.0.2')
      let supplierCalls = 0
      const api: { path: string; authorization: boolean; csrf: boolean }[] = []
      await page.exposeFunction('countSupplier', () => { supplierCalls++ })
      if (app.mode === 'header') {
        await page.getByLabel('예제 로그인 토큰').fill(app.login)
        await widget.evaluate(element => element.addEventListener('example-request-headers', () => {
          const count: unknown = Reflect.get(window, 'countSupplier')
          if (typeof count !== 'function') throw new Error('헤더 호출 관측 함수가 없습니다.')
          void count()
        }))
      }
      page.on('request', request => {
        const path = new URL(request.url()).pathname
        if (path.startsWith(prefix + '/') && !path.includes('/assets/')) api.push({ path,
          authorization: request.headers().authorization === `Bearer ${app.login}`, csrf: 'x-nori-ai-csrf' in request.headers() })
      })
      await page.getByRole('button', { name: 'AI 대화 열기', exact: true }).click()
      await expect(page.getByRole('button', { name: '새 대화', exact: true })).toBeEnabled()
      await expect(widget.getByRole('button', { name: '검토', exact: true })).toHaveCount(0)
      await page.getByRole('textbox', { name: '질문', exact: true }).fill('중립 업무 자료를 조회해 주세요.')
      await page.getByRole('button', { name: '보내기', exact: true }).click()
      await expect(widget).toContainText('중립 예제 검증 답변')
      expect(app.internalResults).toEqual(['SUCCESS'])
      const query = app.requests.find(request => request.path === '/v1/query')
      expect(query).toBeDefined()
      const body = object(JSON.parse(query?.body ?? '{}'))
      expect(Object.keys(body).sort()).toEqual(['context', 'query'])
      expect(Object.keys(object(body.context)).sort()).toEqual(['referenceTime', 'timezone'])
      queries.push(text(body.query))
      expect(api.find(request => request.path.endsWith('/v1/query'))?.csrf).toBe(app.mode === 'cookie')
      expect(api.every(request => request.authorization === (app.mode === 'header'))).toBe(true)
      if (app.mode === 'header') {
        await expect.poll(() => supplierCalls).toBe(api.length)
        expect(api.every(request => !request.csrf)).toBe(true)
        const session = await context.request.get(app.origin + prefix + '/session', { headers: { Authorization: `Bearer ${app.login}` } })
        expect(object(await session.json()).csrf).toBeNull()
      }
      expect(await widget.evaluate(element => {
        const button = element.shadowRoot?.querySelector('button')
        return { shadow: !!element.shadowRoot, border: button ? getComputedStyle(button).borderTopWidth : null }
      })).toEqual({ shadow: true, border: '1px' })
      await page.getByRole('button', { name: '호스트 0', exact: true }).click()
      await expect(page.getByRole('button', { name: '호스트 1', exact: true })).toBeVisible()
      expect(errors).toEqual([])
      expect(app.failures).toEqual([])
      await context.close()
      contexts.pop()
    }
    expect(queries).toEqual(['중립 업무 자료를 조회해 주세요.', '중립 업무 자료를 조회해 주세요.'])
  } finally {
    const browsers = await Promise.allSettled(contexts.map(context => context.close()))
    const consumers = await Promise.allSettled(apps.map(app => app.close()))
    expect([...browsers, ...consumers].filter(result => result.status === 'rejected')).toEqual([])
  }
})
