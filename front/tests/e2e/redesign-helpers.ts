import { expect, type Page } from '@playwright/test'

export async function reveal(page: Page, label: string): Promise<void> {
  const summary = page.locator('summary').filter({ hasText: label }).first()
  const expanded = await summary.evaluate(element => element.parentElement?.hasAttribute('open'))
  if (!expanded) await summary.click()
}

export async function fillCorrection(page: Page, action: Record<string, unknown>): Promise<void> {
  const array = (value: unknown): unknown[] => {
    if (!Array.isArray(value)) throw new Error('시험 입력은 배열이어야 합니다.')
    return value
  }
  const row = (value: unknown): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('시험 입력은 객체여야 합니다.')
    return value as Record<string, unknown>
  }
  const removeRows = async (name: string) => {
    const buttons = page.getByRole('button', { name: new RegExp(`^${name} \\d+ 삭제$`) })
    while (await buttons.count()) await buttons.last().click()
  }
  const fill = (name: string, value: unknown) => page.getByRole('textbox', { name, exact: true }).fill(String(value))
  if ('locations' in action) {
    await removeRows('문서 위치')
    const locations = array(action.locations)
    for (const [index, value] of locations.entries()) {
      const location = row(value)
      await page.getByRole('button', { name: '문서 위치 추가', exact: true }).click()
      for (const [key, label] of Object.entries({ bucket: '보관함', objectKey: '문서 경로', revision: '문서 판본', section: '절' })) await fill(`${label} ${index + 1}`, location[key])
      for (const [key, label] of Object.entries({ lineFrom: '시작 줄', lineTo: '끝 줄' })) await page.getByRole('spinbutton', { name: `${label} ${index + 1}`, exact: true }).fill(String(location[key]))
    }
  }
  if ('correctAnswer' in action) {
    await removeRows('정답 문장'); await removeRows('핵심 사실')
    for (const [index, value] of array(row(action.correctAnswer).sentences).entries()) {
      const sentence = row(value)
      await page.getByRole('button', { name: '정답 문장 추가', exact: true }).click()
      await fill(`정답 문장 ${index + 1}`, sentence.text)
      await fill(`문장 인용 ${index + 1}`, array(sentence.citations).join(', '))
    }
    for (const [index, fact] of array(action.expectedFacts).entries()) {
      await page.getByRole('button', { name: '핵심 사실 추가', exact: true }).click()
      await fill(`핵심 사실 ${index + 1}`, fact)
    }
  }
  if ('terms' in action) {
    await removeRows('용어')
    for (const [index, [term, definition]] of Object.entries(row(action.terms)).entries()) {
      await page.getByRole('button', { name: '용어 추가', exact: true }).click()
      await fill(`약어 ${index + 1}`, term)
      await fill(`용어 풀이 ${index + 1}`, definition)
    }
  }
  await expect(page.getByRole('button', { name: '조치 제출', exact: true })).toBeEnabled()
}
