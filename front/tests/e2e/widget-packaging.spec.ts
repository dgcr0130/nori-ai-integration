import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('단일 스크립트가 호스트 없이 한 번만 태그를 정의한다', async ({ page }) => {
  const script = await readFile(new URL('../../dist/widget.js', import.meta.url), 'utf8')
  const requests: string[] = []
  const errors: string[] = []
  page.on('request', request => requests.push(request.url()))
  page.on('pageerror', error => errors.push(error.message))
  await page.route('https://widget.test/**', async route => {
    if (route.request().url() === 'https://widget.test/widget.js') {
      await route.fulfill({ contentType: 'text/javascript', body: script })
    } else if (route.request().url() === 'https://widget.test/') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><nori-ai-widget></nori-ai-widget>' })
    } else {
      throw new Error('허용되지 않은 외부 자산 요청입니다.')
    }
  })
  await page.goto('https://widget.test/')
  await page.evaluate(() => {
    const original = customElements.define.bind(customElements)
    let count = 0
    customElements.define = (...args: Parameters<CustomElementRegistry['define']>) => {
      count++
      original(...args)
    }
    Object.defineProperty(window, 'widgetDefinitionCount', { get: () => count })
  })
  await page.addScriptTag({ url: '/widget.js' })
  await page.addScriptTag({ url: '/widget.js' })
  const state = await page.evaluate(() => {
    const element = document.querySelector('nori-ai-widget')
    if (!element) throw new Error('위젯 태그가 없습니다.')
    const constructor = customElements.get('nori-ai-widget')
    element.remove()
    document.body.append(element)
    return {
      count: Reflect.get(window, 'widgetDefinitionCount') as unknown,
      version: Reflect.get(element, 'integrationVersion') as unknown,
      registered: constructor === element.constructor,
      shadow: element.shadowRoot !== null,
      hostReact: Reflect.has(window, 'React'),
    }
  })
  expect(state).toEqual({ count: 1, version: '1.0.2', registered: true, shadow: true, hostReact: false })
  expect(requests.filter(url => url !== 'https://widget.test/')).toEqual([
    'https://widget.test/widget.js', 'https://widget.test/widget.js',
  ])
  expect(errors).toEqual([])
  await page.evaluate(() => document.querySelector('nori-ai-widget')?.remove())
})
