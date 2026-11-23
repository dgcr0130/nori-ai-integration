import { object, text } from './api'
import { characterCount, feedbackReceipt, Receipt, type FeedbackReceipt } from './feedback'

export type ReviewStatus = 'OPEN' | 'RESOLVED' | 'REJECTED'
export type Cause = 'DOCUMENT' | 'RETRIEVAL' | 'ANSWER' | 'REJECT'
export interface FeedbackEntry extends FeedbackReceipt { rating: string; comment: string; createdAt: string; updatedAt: string }
export interface ReviewDetail {
  feedback: FeedbackEntry; answerId: string; question: string; answer: Record<string, unknown>
  evidence: Record<string, unknown>[]; reviews: Record<string, unknown>[]; questionCase: unknown
}
export interface ReviewDraft { cause: Cause; note: string; locations: string; terms: string; sentences: string; expectedFacts: string }
export interface ReviewState {
  status: ReviewStatus; items: FeedbackEntry[]; nextAfter: string | null; detail: ReviewDetail | null
  draft: ReviewDraft; busy: boolean
}
export const emptyReviewDraft = (): ReviewDraft => ({ cause: 'DOCUMENT', note: '', locations: '[]', terms: '{}', sentences: '[]', expectedFacts: '[]' })
export const emptyReview = (): ReviewState => ({ status: 'OPEN', items: [], nextAfter: null, detail: null, draft: emptyReviewDraft(), busy: false })

function responseEntries(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('응답 형식을 확인할 수 없습니다.')
  return value
}
export function feedbackEntry(value: unknown): FeedbackEntry {
  const row = object(value)
  return { ...feedbackReceipt(row), rating: text(row.rating), comment: text(row.comment), createdAt: text(row.createdAt), updatedAt: text(row.updatedAt) }
}
export function reviewList(value: unknown): { items: FeedbackEntry[]; nextAfter: string | null } {
  const row = object(value)
  return { items: responseEntries(row.items).map(feedbackEntry), nextAfter: row.nextAfter === null ? null : text(row.nextAfter) }
}
export function reviewDetail(value: unknown): ReviewDetail {
  const row = object(value)
  return { feedback: feedbackEntry(row.feedback), answerId: text(row.answerId), question: text(row.question), answer: object(row.answer),
    evidence: responseEntries(row.evidence).map(object), reviews: responseEntries(row.reviews).map(object), questionCase: row.questionCase }
}
export function liveEvidenceOnly(detail: ReviewDetail): boolean {
  return detail.evidence.length > 0 && !detail.evidence.some(evidence => evidence.sourceType === 'DOCUMENT')
}
function count(values: unknown[], min: number, max: number, name: string): void {
  if (values.length < min || values.length > max) throw new Error(`${name}: ${min}~${max}개로 입력해 주세요.`)
}
function length(value: string, min: number, max: number, name: string): void {
  const size = characterCount(value)
  if (size < min || size > max) throw new Error(`${name}: ${min}~${max}자로 입력해 주세요.`)
}
function json(value: string, name: string): unknown {
  try { return JSON.parse(value) as unknown } catch { throw new Error(`${name}: JSON 형식을 확인해 주세요.`) }
}
function inputEntries(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name}: 배열 형식으로 입력해 주세요.`)
  return value
}
function inputObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name}: 객체로 입력해 주세요.`)
  return value as Record<string, unknown>
}
function inputText(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name}: 문자열로 입력해 주세요.`)
  return value
}

export function reviewAction(draft: ReviewDraft, detail: ReviewDetail): Record<string, unknown> {
  const { cause, note } = draft
  if (liveEvidenceOnly(detail) || cause === 'REJECT') {
    length(note, 1, 2000, '조치 메모')
    return { note }
  }
  const locations = inputEntries(json(draft.locations, '문서 위치'), '문서 위치')
  count(locations, cause === 'DOCUMENT' ? 0 : 1, 6, '문서 위치')
  for (const value of locations) {
    const row = inputObject(value, '문서 위치')
    if (Object.keys(row).length !== 6 || !['bucket', 'objectKey', 'revision', 'section'].every(key => typeof row[key] === 'string')
      || !['lineFrom', 'lineTo'].every(key => typeof row[key] === 'number' && Number.isInteger(row[key]))) {
      throw new Error('문서 위치: 여섯 필드와 자료형을 확인해 주세요.')
    }
  }
  if (cause === 'DOCUMENT') {
    length(note, 1, 2000, '조치 메모')
    return { note, locations }
  }
  const expectedFacts = inputEntries(json(draft.expectedFacts, '핵심 사실'), '핵심 사실')
  count(expectedFacts, 1, 20, '핵심 사실')
  for (const fact of expectedFacts) length(inputText(fact, '핵심 사실'), 1, 256, '핵심 사실')
  const sentences = inputEntries(json(draft.sentences, '정답 문장'), '정답 문장')
  count(sentences, 1, 20, '정답 문장')
  for (const value of sentences) {
    const row = inputObject(value, '정답 문장'), sentence = inputText(row.text, '정답 문장'), citations = inputEntries(row.citations, '문장 인용')
    length(sentence, 1, 1000, '정답 문장')
    if (/[\r\n\u0085\u2028\u2029]/.test(sentence)) throw new Error('정답 문장: 줄바꿈을 넣을 수 없습니다.')
    count(citations, 1, 6, '문장 인용')
    if (citations.some(number => typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > locations.length)) {
      throw new Error('문장 인용: 같은 조치의 문서 위치 번호를 입력해 주세요.')
    }
  }
  const action = { correctAnswer: { sentences }, expectedFacts, locations }
  if (cause !== 'RETRIEVAL') return action
  const terms = inputObject(json(draft.terms, '용어'), '용어')
  count(Object.keys(terms), 1, 20, '용어')
  for (const value of Object.values(terms)) inputText(value, '용어')
  return { terms, ...action }
}

export function Review({ state, list, next, open, change, submit }: {
  state: ReviewState; list: (status: ReviewStatus) => void; next: () => void; open: (id: string) => void
  change: (draft: ReviewDraft) => void; submit: () => void
}) {
  const { detail, draft, busy } = state
  const noteOnly = detail !== null && liveEvidenceOnly(detail)
  return <section aria-label="검토 내용">
    <label>검토 상태<select aria-label="검토 상태" value={state.status} disabled={busy} onChange={event => {
      const status = event.target.value
      if (status === 'OPEN' || status === 'RESOLVED' || status === 'REJECTED') list(status)
    }}>{['OPEN', 'RESOLVED', 'REJECTED'].map(status => <option key={status}>{status}</option>)}</select></label>
    <button disabled={busy} onClick={() => list(state.status)}>검토 목록 새로고침</button>
    <section aria-label="검토 목록">
      {state.items.length === 0 && <p>검토 항목이 없습니다.</p>}
      {state.items.map(item => <article key={item.feedbackId}>
        <button disabled={busy} onClick={() => open(item.feedbackId)}>상세 {item.feedbackId}</button>
        <Receipt value={item} /><p>{item.rating} · {item.comment}</p><p>{item.createdAt} · {item.updatedAt}</p>
      </article>)}
      {state.nextAfter !== null && <button disabled={busy} onClick={next}>검토 다음 쪽</button>}
    </section>
    {detail && <section aria-label="검토 상세">
      <Receipt value={detail.feedback} /><p>answerId: {detail.answerId}</p>
      <p>질문</p><pre>{detail.question}</pre><p>답변</p><pre>{JSON.stringify(detail.answer, null, 2)}</pre>
      <p>당시 근거</p><pre>{JSON.stringify(detail.evidence, null, 2)}</pre>
      <p>지적</p><pre>{detail.feedback.comment}</pre>
      <p>기존 조치</p><pre>{JSON.stringify(detail.reviews, null, 2)}</pre>
      <p>재발 문항</p><pre>{JSON.stringify(detail.questionCase, null, 2)}</pre>
      {detail.feedback.state !== 'OPEN' ? <p>OPEN 상태에서만 조치할 수 있습니다.</p> : <section aria-label="검토 조치">
        <p>제출 version: {detail.feedback.version}</p>
        <label>원인<select aria-label="원인" value={draft.cause} disabled={busy} onChange={event => {
          const cause = event.target.value
          if (cause === 'DOCUMENT' || cause === 'RETRIEVAL' || cause === 'ANSWER' || cause === 'REJECT') change({ ...draft, cause })
        }}>{['DOCUMENT', 'RETRIEVAL', 'ANSWER', 'REJECT'].map(cause => <option key={cause}>{cause}</option>)}</select></label>
        {noteOnly && <p>실시간 근거 전용: 조치 메모만 보냅니다.</p>}
        {noteOnly || draft.cause === 'REJECT' || draft.cause === 'DOCUMENT'
          ? <label>조치 메모<textarea aria-label="조치 메모" disabled={busy} value={draft.note} onChange={event => change({ ...draft, note: event.target.value })} /></label> : null}
        {!noteOnly && draft.cause !== 'REJECT' && <>
          <p>문서 위치는 JSON 배열입니다. 각 위치: bucket, objectKey, revision, section(문자열), lineFrom, lineTo(정수).</p>
          <label>문서 위치<textarea aria-label="문서 위치" disabled={busy} value={draft.locations} onChange={event => change({ ...draft, locations: event.target.value })} /></label>
          {draft.cause !== 'DOCUMENT' && <>
            <p>정답 문장은 JSON 배열입니다. 각 문장: text, citations(같은 조치의 문서 위치 번호, 1부터 시작).</p>
            <label>정답 문장<textarea aria-label="정답 문장" disabled={busy} value={draft.sentences} onChange={event => change({ ...draft, sentences: event.target.value })} /></label>
            <label>핵심 사실<textarea aria-label="핵심 사실" disabled={busy} value={draft.expectedFacts} onChange={event => change({ ...draft, expectedFacts: event.target.value })} /></label>
            <p>핵심 사실은 문자열 JSON 배열입니다.</p>
          </>}
          {draft.cause === 'RETRIEVAL' && <><label>용어<textarea aria-label="용어" disabled={busy} value={draft.terms} onChange={event => change({ ...draft, terms: event.target.value })} /></label><p>용어는 약어와 풀이의 JSON 객체입니다.</p></>}
        </>}
        <button disabled={busy} onClick={submit}>조치 제출</button>
      </section>}
    </section>}
  </section>
}
