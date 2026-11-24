import { test, expect, login, openWidget } from './backend'
import { fillCorrection } from './redesign-helpers'

const locations = [1, 2].map(number => ({ bucket: 'manuals', objectKey: `guide-${number}.md`,
  revision: 'a'.repeat(64), section: '안내', lineFrom: 1, lineTo: 3 }))

test('문장 첫 행 삭제 후 인용 표시·blur·payload와 다른 검토의 초기 입력이 일치한다', async ({ page, context, backend }, testInfo) => {
  backend.reviewers.add('alice')
  const first = backend.seedReview(), second = backend.seedReview()
  backend.feedbacks.get(first)!.detail.feedback.comment = '문장 첫 검토'
  backend.feedbacks.get(second)!.detail.feedback.comment = '문장 다음 검토'
  await login(context, backend); await openWidget(page, backend)
  await page.getByRole('button', { name: '검토', exact: true }).click()
  await page.getByRole('button', { name: /^검토 항목.*문장 첫 검토/ }).click()
  await page.getByRole('combobox', { name: '원인', exact: true }).selectOption('ANSWER')
  const action = { locations, expectedFacts: ['유지할 사실'], correctAnswer: { sentences: [
    { text: '삭제할 첫 문장', citations: [1] }, { text: '유지할 두 번째 문장', citations: [2] },
  ] } }
  await fillCorrection(page, action)
  await page.getByRole('button', { name: '정답 문장 1 삭제', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '정답 문장 1', exact: true })).toHaveValue('유지할 두 번째 문장')
  const citations = page.getByRole('textbox', { name: '문장 인용 1', exact: true })
  await expect.soft(citations).toHaveValue('2')
  await citations.focus(); await citations.press('Tab')
  await expect.soft(citations).toHaveValue('2')
  await page.screenshot({ path: testInfo.outputPath('sentence-row-deletion.png') })
  await page.getByRole('button', { name: '조치 제출', exact: true }).click()
  const posts = () => backend.apiRequests.filter(row => row.path.endsWith('/resolve'))
  await expect.poll(() => posts().length).toBe(1)
  expect.soft(JSON.parse(posts()[0]!.body)).toEqual({ version: 1, cause: 'ANSWER', action: {
    ...action, correctAnswer: { sentences: [action.correctAnswer.sentences[1]] },
  } })

  await page.getByRole('button', { name: /^검토 항목.*문장 다음 검토/ }).click()
  await page.getByRole('combobox', { name: '원인', exact: true }).selectOption('ANSWER')
  await expect(page.getByRole('textbox', { name: '문장 인용 1', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '정답 문장 추가', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '문장 인용 1', exact: true })).toHaveValue('')
  const nextAction = { locations, expectedFacts: ['다음 사실'], correctAnswer: {
    sentences: [{ text: '다른 검토의 문장', citations: [1, 2] }],
  } }
  await fillCorrection(page, nextAction)
  await page.getByRole('button', { name: '조치 제출', exact: true }).click()
  await expect.poll(() => posts().length).toBe(2)
  expect(JSON.parse(posts()[1]!.body)).toEqual({ version: 1, cause: 'ANSWER', action: nextAction })
})

test('중복·빈 약어 편집은 두 행과 풀이를 보존하고 제출에서 명확히 거절한다', async ({ page, context, backend }, testInfo) => {
  backend.reviewers.add('alice')
  backend.seedReview()
  await login(context, backend); await openWidget(page, backend)
  await page.getByRole('button', { name: '검토', exact: true }).click()
  await page.getByRole('button', { name: /^검토 항목/ }).click()
  await page.getByRole('combobox', { name: '원인', exact: true }).selectOption('RETRIEVAL')
  const action = { locations, terms: { AA: '첫 번째 풀이', BB: '두 번째 풀이' }, expectedFacts: ['유지할 사실'],
    correctAnswer: { sentences: [{ text: '용어 검토 문장', citations: [1, 2] }] } }
  await fillCorrection(page, action)
  const terms = page.getByRole('textbox', { name: /^약어 \d+$/ })
  await page.getByRole('textbox', { name: '약어 1', exact: true }).fill('BB')
  await expect.soft(terms).toHaveCount(2)
  await expect.soft(page.getByRole('textbox', { name: '용어 풀이 1', exact: true })).toHaveValue('첫 번째 풀이')
  await page.getByRole('button', { name: '조치 제출', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('중복된 약어')
  const posts = () => backend.apiRequests.filter(row => row.path.endsWith('/resolve'))
  expect(posts()).toHaveLength(0)
  await page.getByRole('textbox', { name: '약어 1', exact: true }).fill('')
  await page.getByRole('textbox', { name: '약어 2', exact: true }).fill('')
  await expect(terms).toHaveCount(2)
  await expect(page.getByRole('textbox', { name: '용어 풀이 1', exact: true })).toHaveValue('첫 번째 풀이')
  await expect(page.getByRole('textbox', { name: '용어 풀이 2', exact: true })).toHaveValue('두 번째 풀이')
  await page.getByRole('button', { name: '조치 제출', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('약어를 입력')
  expect(posts()).toHaveLength(0)
  await page.getByRole('textbox', { name: '약어 1', exact: true }).fill('AA')
  await page.getByRole('textbox', { name: '약어 2', exact: true }).fill('BB')
  await page.screenshot({ path: testInfo.outputPath('terms-preserved.png') })
  await page.getByRole('button', { name: '조치 제출', exact: true }).click()
  await expect.poll(() => posts().length).toBe(1)
  expect(JSON.parse(posts()[0]!.body)).toEqual({ version: 1, cause: 'RETRIEVAL', action })
})

test('삭제한 문서의 단독 인용은 빈 선택으로 남고 다른 문서로 제출되지 않는다', async ({ page, context, backend }, testInfo) => {
  backend.reviewers.add('alice')
  backend.seedReview()
  await login(context, backend); await openWidget(page, backend)
  await page.getByRole('button', { name: '검토', exact: true }).click()
  await page.getByRole('button', { name: /^검토 항목/ }).click()
  await page.getByRole('combobox', { name: '원인', exact: true }).selectOption('ANSWER')
  await fillCorrection(page, { locations, expectedFacts: ['문서 A 사실'], correctAnswer: {
    sentences: [{ text: '문서 A를 근거로 작성한 문장', citations: [1] }],
  } })
  await page.getByRole('button', { name: '문서 위치 1 삭제', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '문서 경로 1', exact: true })).toHaveValue(locations[1]!.objectKey)
  const input = page.getByRole('textbox', { name: '문장 인용 1', exact: true })
  await expect.soft(input).toHaveValue('')
  await input.focus(); await input.press('Tab')
  await expect.soft(input).toHaveValue('')
  await page.getByRole('button', { name: '조치 제출', exact: true }).click()
  await expect(page.getByRole('button', { name: '조치 제출', exact: true })).toBeEnabled()
  await expect(page.getByRole('alert')).toContainText('문장 인용')
  expect(backend.apiRequests.filter(row => row.path.endsWith('/resolve'))).toHaveLength(0)
  await input.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('removed-location-unresolved.png') })
})

for (const citations of [[2], [1, 2]]) {
  test(`문서 위치 삭제는 남은 문서의 의미를 보존한다: 기존 인용 ${citations.join(', ')}`, async ({ page, context, backend }, testInfo) => {
    backend.reviewers.add('alice')
    backend.seedReview()
    await login(context, backend); await openWidget(page, backend)
    await page.getByRole('button', { name: '검토', exact: true }).click()
    await page.getByRole('button', { name: /^검토 항목/ }).click()
    await page.getByRole('combobox', { name: '원인', exact: true }).selectOption('ANSWER')
    await fillCorrection(page, { locations, expectedFacts: ['남은 문서 B 사실'], correctAnswer: {
      sentences: [{ text: '문서 B의 근거를 유지할 문장', citations }],
    } })
    await page.getByRole('button', { name: '문서 위치 1 삭제', exact: true }).click()
    const input = page.getByRole('textbox', { name: '문장 인용 1', exact: true })
    await expect.soft(input).toHaveValue('1')
    await input.focus(); await input.press('Tab')
    await expect.soft(input).toHaveValue('1')
    await page.screenshot({ path: testInfo.outputPath('remaining-location-preserved.png') })
    await page.getByRole('button', { name: '조치 제출', exact: true }).click()
    const posts = () => backend.apiRequests.filter(row => row.path.endsWith('/resolve'))
    await expect.poll(() => posts().length).toBe(1)
    const submitted = JSON.parse(posts()[0]!.body)
    expect(submitted).toEqual({ version: 1, cause: 'ANSWER', action: {
      locations: [locations[1]], expectedFacts: ['남은 문서 B 사실'],
      correctAnswer: { sentences: [{ text: '문서 B의 근거를 유지할 문장', citations: [1] }] },
    } })
    expect(submitted.action.locations[submitted.action.correctAnswer.sentences[0].citations[0] - 1]).toEqual(locations[1])
  })
}

test('문서 위치 삭제는 불완전·유효하지 않은 인용 입력을 유효한 참조로 바꾸지 않는다', async ({ page, context, backend }) => {
  backend.reviewers.add('alice')
  backend.seedReview()
  await login(context, backend); await openWidget(page, backend)
  await page.getByRole('button', { name: '검토', exact: true }).click()
  await page.getByRole('button', { name: /^검토 항목/ }).click()
  await page.getByRole('combobox', { name: '원인', exact: true }).selectOption('ANSWER')
  for (const [value, remapped] of [['2,', '1,'], ['1, 2,', '1,'], [', 2', ',1'], ['2e', '2e'], ['3', '3']]) {
    await fillCorrection(page, { locations, expectedFacts: ['인용을 확인할 사실'], correctAnswer: {
      sentences: [{ text: '불완전한 인용 입력을 유지할 문장', citations: [2] }],
    } })
    const input = page.getByRole('textbox', { name: '문장 인용 1', exact: true })
    await input.fill(value!); await input.press('Tab')
    await page.getByRole('button', { name: '문서 위치 1 삭제', exact: true }).click()
    await expect(input).toHaveValue(remapped!)
    await input.focus(); await input.press('Tab')
    await expect(input).toHaveValue(remapped!)
    await page.getByRole('button', { name: '조치 제출', exact: true }).click()
    await expect(page.getByRole('button', { name: '조치 제출', exact: true })).toBeEnabled()
    await expect(page.getByRole('alert')).toContainText('문장 인용')
    expect(backend.apiRequests.filter(row => row.path.endsWith('/resolve'))).toHaveLength(0)
  }
})
