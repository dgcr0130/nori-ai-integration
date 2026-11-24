import { object, text } from './api'
import { ReadableValue, statusLabel } from './readable'
import { characterCount, feedbackReceipt, Receipt, type FeedbackReceipt } from './feedback'

export type ReviewStatus = 'OPEN' | 'RESOLVED' | 'REJECTED'
export type Cause = 'DOCUMENT' | 'RETRIEVAL' | 'ANSWER' | 'REJECT'
export interface FeedbackEntry extends FeedbackReceipt { rating: string; comment: string; createdAt: string; updatedAt: string }
export interface ReviewDetail {
  feedback: FeedbackEntry; answerId: string; question: string; answer: Record<string, unknown>
  evidence: Record<string, unknown>[]; reviews: Record<string, unknown>[]; questionCase: unknown
}
export interface ReviewDraft {
  cause: Cause; note: string; locations: string; terms: string; sentences: string; expectedFacts: string
  citationInputs?: string[]; termInputs?: [string, string][]
}
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
  let terms: Record<string, unknown>
  if (draft.termInputs === undefined) terms = inputObject(json(draft.terms, '용어'), '용어')
  else {
    // 편집 중에는 빈 키와 중복 키도 행으로 보존하고 제출 시에만 유일 키 객체로 만든다.
    count(draft.termInputs, 1, 20, '용어')
    const keys = new Set<string>()
    for (const [term] of draft.termInputs) {
      if (!term.trim()) throw new Error('용어: 약어를 입력해 주세요.')
      if (keys.has(term)) throw new Error('용어: 중복된 약어를 확인해 주세요.')
      keys.add(term)
    }
    terms = Object.fromEntries(draft.termInputs)
  }
  count(Object.keys(terms), 1, 20, '용어')
  for (const value of Object.values(terms)) inputText(value, '용어')
  return { terms, ...action }
}

export function ReviewList({ state, list, next, open }: {
  state: ReviewState; list: (status: ReviewStatus) => void; next: () => void; open: (id: string) => void
}) {
  return <section aria-label="검토 목록">
    <label>검토 상태<select aria-label="검토 상태" value={state.status} disabled={state.busy} onChange={event => {
      const status = event.target.value
      if (status === 'OPEN' || status === 'RESOLVED' || status === 'REJECTED') list(status)
    }}>{['OPEN', 'RESOLVED', 'REJECTED'].map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></label>
    <button className="reload-button" disabled={state.busy} onClick={() => list(state.status)}>검토 목록 새로고침</button>
    {state.items.length === 0 && <p className="muted">검토 항목이 없습니다.</p>}
    {state.items.map((item, index) => <article className="review-row" key={item.feedbackId}>
      <button disabled={state.busy} onClick={() => open(item.feedbackId)} aria-label={`검토 항목 ${index + 1}: ${item.comment || "피드백"}`}>
        <span>{item.comment || '피드백 검토'}</span><small>{statusLabel(item.state)} · {statusLabel(item.rating)}</small>
      </button>
    </article>)}
    {state.nextAfter !== null && <button disabled={state.busy} onClick={next}>검토 다음 쪽</button>}
  </section>
}

interface LocationInput { bucket: string; objectKey: string; revision: string; section: string; lineFrom: number; lineTo: number }
interface SentenceInput { text: string; citations: number[] }
const newLocation = (): LocationInput => ({ bucket: '', objectKey: '', revision: '', section: '', lineFrom: 1, lineTo: 1 })
const citationNumbers = (value: string): number[] => value.trim() ? value.split(',').map(number => Number(number.trim())) : []

function CorrectionFields({ draft, busy, change }: { draft: ReviewDraft; busy: boolean; change: (draft: ReviewDraft) => void }) {
  // 직렬화는 기존 검증·API 계약을 재사용하기 위한 내부 표현이며 편집 화면은 구조화한다.
  const locations = JSON.parse(draft.locations) as LocationInput[]
  const sentences = JSON.parse(draft.sentences) as SentenceInput[]
  const facts = JSON.parse(draft.expectedFacts) as string[]
  const citationInputs = draft.citationInputs ?? sentences.map(sentence => sentence.citations.join(', '))
  const terms = draft.termInputs ?? Object.entries(JSON.parse(draft.terms) as Record<string, string>)
  const set = (field: 'locations' | 'sentences' | 'expectedFacts', value: unknown) => change({ ...draft, [field]: JSON.stringify(value) })
  const setSentences = (values: SentenceInput[], inputs: string[]) => change({ ...draft, sentences: JSON.stringify(values), citationInputs: inputs })
  const setTerms = (values: [string, string][]) => change({ ...draft, termInputs: values })
  const removeLocation = (index: number) => {
    const inputs = citationInputs.map(input => input.split(',').flatMap(part => {
      const number = Number(part.trim())
      // 빈 토큰·잘못된 번호는 보존해 불완전 입력이 삭제 과정에서 유효해지지 않게 한다.
      if (!part.trim() || !Number.isInteger(number) || number < 1 || number > locations.length) return [part]
      if (number === index + 1) return []
      return [number > index + 1 ? String(number - 1) : part]
    }).join(','))
    // 위치와 두 인용 표현을 한 번에 바꿔 같은 문서 참조를 유지한다.
    change({ ...draft, locations: JSON.stringify(locations.filter((_, position) => position !== index)),
      sentences: JSON.stringify(sentences.map((sentence, position) => ({ ...sentence, citations: citationNumbers(inputs[position] ?? '') }))),
      citationInputs: inputs })
  }
  return <fieldset disabled={busy} className="correction-fields">
    <legend>수정 자료</legend>
    <section aria-label="문서 위치 편집"><h4>문서 위치</h4>
      {locations.map((location, index) => <fieldset key={index} aria-label={`문서 위치 ${index + 1}`}><legend>문서 위치 {index + 1}</legend>
        {(['bucket', 'objectKey', 'revision', 'section', 'lineFrom', 'lineTo'] as const).map(key => {
          const label = { bucket: '보관함', objectKey: '문서 경로', revision: '문서 판본', section: '절', lineFrom: '시작 줄', lineTo: '끝 줄' }[key]
          const numeric = key === 'lineFrom' || key === 'lineTo'
          return <label key={key}>{label}<input aria-label={`${label} ${index + 1}`} type={numeric ? 'number' : 'text'} value={location[key]} onChange={event => set('locations', locations.map((row, position) => position === index ? { ...row, [key]: numeric ? Number(event.target.value) : event.target.value } : row))} /></label>
        })}
        <button onClick={() => removeLocation(index)}>문서 위치 {index + 1} 삭제</button>
      </fieldset>)}
      <button onClick={() => set('locations', [...locations, newLocation()])}>문서 위치 추가</button>
    </section>
    {draft.cause !== 'DOCUMENT' && <>
      <section aria-label="정답 문장 편집"><h4>정답 문장</h4>
        {sentences.map((sentence, index) => <fieldset key={index}><legend>정답 문장 {index + 1}</legend>
          <label>문장<textarea aria-label={`정답 문장 ${index + 1}`} value={sentence.text} onChange={event => set('sentences', sentences.map((row, position) => position === index ? { ...row, text: event.target.value } : row))} /></label>
          <label>인용할 문서 위치 번호 (쉼표로 구분)<input aria-label={`문장 인용 ${index + 1}`} value={citationInputs[index]} onChange={event => {
            const value = event.target.value
            setSentences(sentences.map((row, position) => position === index ? { ...row, citations: citationNumbers(value) } : row),
              citationInputs.map((input, position) => position === index ? value : input))
          }} /></label>
          <button onClick={() => setSentences(sentences.filter((_, position) => position !== index), citationInputs.filter((_, position) => position !== index))}>정답 문장 {index + 1} 삭제</button>
        </fieldset>)}
        <button onClick={() => setSentences([...sentences, { text: '', citations: [] }], [...citationInputs, ''])}>정답 문장 추가</button>
      </section>
      <section aria-label="핵심 사실 편집"><h4>핵심 사실</h4>{facts.map((fact, index) => <div className="editor-row" key={index}>
        <textarea aria-label={`핵심 사실 ${index + 1}`} value={fact} onChange={event => set('expectedFacts', facts.map((row, position) => position === index ? event.target.value : row))} />
        <button onClick={() => set('expectedFacts', facts.filter((_, position) => position !== index))}>핵심 사실 {index + 1} 삭제</button>
      </div>)}<button onClick={() => set('expectedFacts', [...facts, ''])}>핵심 사실 추가</button></section>
      {draft.cause === 'RETRIEVAL' && <section aria-label="용어 편집"><h4>용어</h4>{terms.map(([term, definition], index) => <div key={index}>
        <label>약어<input aria-label={`약어 ${index + 1}`} value={term} onChange={event => setTerms(terms.map<[string, string]>((row, position) => position === index ? [event.target.value, definition] : row))} /></label>
        <label>풀이<input aria-label={`용어 풀이 ${index + 1}`} value={definition} onChange={event => setTerms(terms.map<[string, string]>((row, position) => position === index ? [term, event.target.value] : row))} /></label>
        <button onClick={() => setTerms(terms.filter((_, position) => position !== index))}>용어 {index + 1} 삭제</button>
      </div>)}<button onClick={() => setTerms([...terms, ['', '']])}>용어 추가</button></section>}
    </>}
  </fieldset>
}

export function Review({ state, change, submit }: {
  state: ReviewState; change: (draft: ReviewDraft) => void; submit: () => void
}) {
  const { detail, draft, busy } = state
  if (!detail) return <section aria-label="검토 내용"><h2>답변 검토</h2><p className="muted">목록에서 검토할 항목을 선택해 주세요.</p></section>
  const noteOnly = liveEvidenceOnly(detail)
  return <section aria-label="검토 상세">
    <h2>답변 검토</h2><Receipt value={detail.feedback} />
    <h3>질문</h3><p className="answer-text">{detail.question}</p>
    <h3>답변</h3><ReadableValue value={detail.answer.text ?? detail.answer} />
    <details><summary>당시 근거</summary><ReadableValue value={detail.evidence} /></details>
    <h3>지적</h3><p className="answer-text">{detail.feedback.comment}</p>
    <details><summary>기존 조치 · 재발 문항</summary><ReadableValue value={detail.reviews} /><ReadableValue value={detail.questionCase} /></details>
    {detail.feedback.state !== 'OPEN' ? <p>검토 대기 상태에서만 조치할 수 있습니다.</p> : <section aria-label="검토 조치">
      <h3>검토 조치</h3>
      <label>원인<select aria-label="원인" value={draft.cause} disabled={busy} onChange={event => {
        const cause = event.target.value
        if (cause === 'DOCUMENT' || cause === 'RETRIEVAL' || cause === 'ANSWER' || cause === 'REJECT') change({ ...draft, cause })
      }}>{['DOCUMENT', 'RETRIEVAL', 'ANSWER', 'REJECT'].map(cause => <option key={cause} value={cause}>{statusLabel(cause)}</option>)}</select></label>
      {noteOnly && <p>실시간 근거 전용: 조치 메모만 보냅니다.</p>}
      {(noteOnly || draft.cause === 'REJECT' || draft.cause === 'DOCUMENT') && <label>조치 메모<textarea aria-label="조치 메모" disabled={busy} value={draft.note} onChange={event => change({ ...draft, note: event.target.value })} /></label>}
      {!noteOnly && draft.cause !== 'REJECT' && <CorrectionFields draft={draft} busy={busy} change={change} />}
      <button className="primary-button" disabled={busy} onClick={submit}>조치 제출</button>
    </section>}
  </section>
}
