import { object, text, ApiFailure } from './api'
import { statusLabel } from './readable'

export interface FeedbackReceipt { feedbackId: string; version: number; state: string }
export interface FeedbackDraft { comment: string; receipt: FeedbackReceipt | null; busy: boolean }
export const emptyFeedback = (): FeedbackDraft => ({ comment: '', receipt: null, busy: false })
export const characterCount = (value: string): number => [...value].length

export function feedbackReceipt(value: unknown): FeedbackReceipt {
  const row = object(value)
  if (typeof row.version !== 'number' || !Number.isInteger(row.version) || row.version < 1) throw new Error('응답 형식을 확인할 수 없습니다.')
  return { feedbackId: text(row.feedbackId), version: row.version, state: text(row.state) }
}

// 이 네 경로의 고정 message만으로는 오류를 구분할 수 없어 상태·코드를 함께 표시한다.
export function feedbackError(error: unknown): unknown {
  if (error instanceof ApiFailure && !error.identityFailure) {
    return new ApiFailure(error.status, { code: error.code,
      message: `HTTP ${error.status}${error.code ? ` ${error.code}` : ''}: ${error.message}` },
    new Headers(error.retryAfter === null ? {} : { 'Retry-After': error.retryAfter }))
  }
  return error
}

export function Receipt({ value }: { value: FeedbackReceipt }) {
  return <p className="muted" role="status">접수되었습니다. · {statusLabel(value.state)} · {value.version}차</p>
}

export function Feedback({ draft, change, submit }: {
  draft: FeedbackDraft; change: (comment: string) => void; submit: (rating: 'UP' | 'DOWN') => void
}) {
  return <section aria-label="피드백">
    <details><summary>의견 남기기</summary><label>지적<textarea aria-label="지적" value={draft.comment} disabled={draft.busy} onChange={event => change(event.target.value)} /></label>
    <p className="muted">{characterCount(draft.comment)} / 2000자</p></details>
    <button disabled={draft.busy} onClick={() => submit('UP')}>도움이 됨</button>
    <button disabled={draft.busy} onClick={() => submit('DOWN')}>도움이 안 됨</button>
    {draft.receipt && <Receipt value={draft.receipt} />}
  </section>
}
