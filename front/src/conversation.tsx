import { useEffect, useRef, useSyncExternalStore, useState } from 'react'
import { AiApi, ApiFailure, LoginRequired, TransportFailure, object, questionContext, text, type Session } from './api'
import { readEvents, terminalEvents } from './stream'
import { Feedback, emptyFeedback, characterCount, feedbackReceipt, feedbackError, type FeedbackDraft } from './feedback'
import { Review, ReviewList, emptyReview, emptyReviewDraft, reviewList, reviewDetail, reviewAction, type ReviewState, type ReviewStatus, type ReviewDraft } from './review'
import { Icon } from './icons'
import { statusLabel } from './readable'

interface Accepted { jobId: string; conversationId: string; messageId: string; queuePosition: number }
interface LogicalQuestion { path: string; body: string; key: string; query: string }
interface ConversationEntry { id: string; title: string | null }
interface Citation { number: number; evidenceId: string; sourceType: string; title: string | null }
interface Answer { kind: string; text: string; citations: Citation[] }
interface Result { jobId: string; jobStatus: string; answer: Answer | null; denied: boolean }
interface Message { id: string; role: string; content: string | Result }
interface Job { accepted: Accepted; active: boolean; lastId: string; interrupted: boolean }
interface State {
  tab: 'conversation' | 'review'; sidebar: boolean; validating: boolean; query: string; conversationId: string | null
  items: ConversationEntry[]; nextAfter: string | null; listLoading: boolean; listFailed: boolean; messages: Message[]
  job: Job | null; retry: LogicalQuestion | null; progress: string[]; resultLoading: boolean; resultFailed: boolean
  // 열린 근거만 키를 갖는다. null은 불러오는 중이다. 키는 sourceKey(jobId, evidenceId)이다.
  notice: string; retryAfter: string | null; sources: Record<string, string | null>
  busy: boolean; ready: boolean; blocked: boolean; cancelResult: string; detailLoading: boolean; detailFailed: boolean
  canReview: boolean; review: ReviewState; feedback: Record<string, FeedbackDraft>
}

const initialState = (): State => ({
  tab: 'conversation', sidebar: false, validating: false, query: '', conversationId: null, items: [], nextAfter: null, listLoading: false, listFailed: false, messages: [],
  job: null, retry: null, progress: [], resultLoading: false, resultFailed: false, notice: '', retryAfter: null, sources: {},
  busy: false, ready: false, blocked: true, cancelResult: '', detailLoading: false, detailFailed: false,
  canReview: false, review: emptyReview(), feedback: {},
})

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('응답 형식을 확인할 수 없습니다.')
  return value
}

/** 저장 본문 전체를 보존하고 구조화 문장과 유일하게 일치하는 생성 접미사만 투영한다. */
export function displayAnswer(answer: Record<string, unknown>): string {
  const body = text(answer.text)
  if (!Array.isArray(answer.sentences) || !Array.isArray(answer.citations)) return body
  const numbers = new Set(answer.citations.map(value => object(value).number))
  const removals: { start: number; end: number }[] = []
  for (const value of answer.sentences) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const sentence = object(value)
    if (typeof sentence.text !== 'string' || !sentence.text || !Array.isArray(sentence.citations) || !sentence.citations.length) continue
    if (!sentence.citations.every(n => typeof n === 'number' && Number.isInteger(n) && numbers.has(n))) continue
    const suffix = sentence.citations.map(n => `[${n}]`).join('')
    const generated = sentence.text + suffix
    const start = body.indexOf(generated)
    if (start < 0 || body.indexOf(generated, start + 1) >= 0) continue
    removals.push({ start: start + sentence.text.length, end: start + generated.length })
  }
  const unique = [...new Map(removals.map(range => [range.start, range])).values()].sort((a, b) => a.start - b.start)
  if (unique.some((range, index) => index > 0 && range.start < unique[index - 1]!.end)) return body
  let projected = body
  for (const range of unique.reverse()) projected = projected.slice(0, range.start) + projected.slice(range.end)
  return projected
}

function resultView(value: unknown): Result {
  const root = object(value)
  const result = root.result === null || root.result === undefined ? null : object(root.result)
  const payload = result === null ? null : object(result.payload)
  const answer = payload?.answer === undefined || payload.answer === null ? null : object(payload.answer)
  return {
    jobId: text(root.jobId), jobStatus: text(root.jobStatus), denied: root.resultAccess === 'DENIED',
    answer: answer === null ? null : {
      kind: text(answer.kind), text: displayAnswer(answer),
      citations: array(answer.citations).map(entry => {
        const citation = object(entry)
        if (typeof citation.number !== 'number') throw new Error('응답 형식을 확인할 수 없습니다.')
        // title이 생기기 전에 저장된 답변은 출처 종류로 표시한다.
        const title = typeof citation.title === 'string' && citation.title.trim() ? citation.title : null
        return { number: citation.number, evidenceId: text(citation.evidenceId), sourceType: text(citation.sourceType), title }
      }),
    },
  }
}

function acceptedView(value: unknown): Accepted {
  const accepted = object(value)
  if (typeof accepted.queuePosition !== 'number') throw new Error('응답 형식을 확인할 수 없습니다.')
  return { jobId: text(accepted.jobId), conversationId: text(accepted.conversationId), messageId: text(accepted.messageId), queuePosition: accepted.queuePosition }
}

export class ConversationModel {
  private state = initialState()
  private readonly listeners = new Set<() => void>()
  private sessionValue: Session | null = null
  private generation = 0
  private disposed = false
  private stream: AbortController | null = null
  private sourceRevision = 0
  private reviewRevision = 0
  private validation: Promise<void> | null = null
  private sessionFlight: { generation: number; promise: Promise<boolean>; controller: AbortController; commandOwned: boolean } | null = null
  private readonly pendingUserTasks = new Map<string, Promise<void>>()
  private focusRevision = 0
  private signedOut = false
  private conversationRevision = 0
  private detailSequence = 0
  private detailTarget: string | null = null
  private resultSequence = 0
  private focusReadPending = false
  private listRevision = 0
  private readonly listCursors = new Set<string>()
  private listVisited = false
  private admission: LogicalQuestion | null = null

  constructor(private readonly api: AiApi) {}
  snapshot = (): State => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private update(value: Partial<State>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...value }
    for (const listener of this.listeners) listener()
  }
  private assertCurrent(generation: number): void {
    if (this.disposed || generation !== this.generation) throw new DOMException('종료된 화면입니다.', 'AbortError')
  }
  private clear(): void {
    this.generation++
    this.sessionFlight?.controller.abort(); this.sessionFlight = null
    this.conversationRevision++
    this.detailTarget = null
    this.focusRevision++; this.validation = null
    this.focusReadPending = false
    this.pendingUserTasks.clear()
    this.sourceRevision++
    this.reviewRevision++
    this.listRevision++; this.listCursors.clear()
    this.listVisited = false
    this.stream?.abort(); this.stream = null
    this.api.cancelAll(); this.sessionValue = null
    this.admission = null
    this.state = initialState()
  }
  dispose(): void {
    this.focusRevision++
    this.clear(); this.api.dispose(); this.disposed = true; this.listeners.clear()
  }
  private clearSources(): void {
    this.sourceRevision++
    this.update({ sources: {} })
  }
  private invalidateConversationReads(): void {
    this.conversationRevision++; this.detailSequence++; this.resultSequence++
    this.detailTarget = null
    this.update({ detailLoading: false, detailFailed: false, resultLoading: false, resultFailed: false })
  }
  private failure(error: unknown): void {
    if (this.disposed || (error instanceof DOMException && error.name === 'AbortError')) return
    if (error instanceof LoginRequired || (error instanceof ApiFailure && error.identityFailure)) {
      if (error instanceof LoginRequired || error.loginRequired) this.clear()
      else this.quarantine()
      this.update({ notice: error instanceof LoginRequired || error.loginRequired ? '로그인이 필요합니다.' : error.message })
      return
    }
    if (error instanceof ApiFailure && error.status === 403) this.clearSources()
    this.update({ notice: error instanceof Error ? error.message : '요청을 처리할 수 없습니다.',
      retryAfter: error instanceof ApiFailure ? error.retryAfter : null })
  }
  private async task(action: () => Promise<void>): Promise<void> {
    const generation = this.generation
    try { await action() } catch (error) {
      if (generation === this.generation) this.failure(error)
    }
  }
  private userTask(action: () => Promise<void>, options: { key?: string; authenticates?: boolean } = {}): Promise<void> {
    if (!this.state.ready || this.state.blocked || this.signedOut) return Promise.resolve()
    // 명령 자체가 공유 인증을 시작하는 경로는 즉시 잠금을 잡는다. 자료 작업은 현재 인증을 먼저 기다린다.
    const generation = this.generation, subject = this.sessionValue?.subject
    const target = this.state.conversationId, jobId = this.state.job?.accepted.jobId
    const key = options.key
    if (key && this.pendingUserTasks.has(key)) return this.pendingUserTasks.get(key)!
    const execute = options.authenticates || !this.sessionFlight ? action : async () => {
      await this.awaitAuthentication(generation, subject)
      if (target !== this.state.conversationId || jobId !== this.state.job?.accepted.jobId) return
      await action()
    }
    const pending = this.task(execute).finally(() => { if (key && this.pendingUserTasks.get(key) === pending) this.pendingUserTasks.delete(key) })
    if (key) this.pendingUserTasks.set(key, pending)
    return pending
  }
  private async awaitAuthentication(generation: number, subject: string | undefined): Promise<void> {
    while (this.sessionFlight) {
      const flight = this.sessionFlight
      try {
        if (!await flight.promise) throw new DOMException('변경된 신원입니다.', 'AbortError')
      } catch (error) {
        // 재열기만으로 교체된 focus 인증은 새 확인을 따른다. 신원 회수/격리는 세대 검사에서 폐기한다.
        this.assertCurrent(generation)
        if (flight.controller.signal.aborted && this.sessionFlight && this.sessionFlight !== flight) continue
        throw error
      }
      this.assertCurrent(generation)
    }
    this.assertCurrent(generation)
    if (!this.state.ready || this.state.blocked || this.signedOut || subject !== this.sessionValue?.subject) {
      throw new DOMException('종료된 인증입니다.', 'AbortError')
    }
  }
  private quarantine(): void {
    // 확인 불가는 로그아웃과 다르다. 신원 결속 메모리는 보존하되 비동기 응답과 보호 화면을 격리한다.
    this.generation++; this.sessionFlight?.controller.abort(); this.sessionFlight = null
    this.focusRevision++; this.validation = null; this.conversationRevision++
    this.detailTarget = null
    this.focusReadPending = false
    this.pendingUserTasks.clear()
    this.reviewRevision++; this.listRevision++; this.sourceRevision++
    this.api.cancelAll(); this.stream?.abort(); this.stream = null
    this.update({ ready: false, validating: false, blocked: true, busy: false, listLoading: false, detailLoading: false,
      ...(this.admission ? { retry: this.admission } : {}),
      review: { ...this.state.review, busy: false },
      feedback: Object.fromEntries(Object.entries(this.state.feedback).map(([id, draft]) => [id, { ...draft, busy: false }])),
      job: this.state.job?.active ? { ...this.state.job, interrupted: true } : this.state.job })
  }
  invalidateAuth = (mode: 'signed-out' | 'invalidate' | 'check'): void => {
    this.focusRevision++
    this.validation = null
    this.signedOut = mode === 'signed-out'
    this.clear()
    this.update({ notice: mode === 'signed-out' ? '로그인이 필요합니다.' : '' })
    if (mode === 'check') void this.focus(true)
  }
  private async request(path: string, options: Parameters<AiApi['request']>[1] = {}): Promise<unknown> {
    const generation = this.generation, subject = this.sessionValue?.subject
    try {
      await this.awaitAuthentication(generation, subject)
      const result = await this.api.request(path, options)
      // 이미 전송된 자료도 새 인증 확인 중에는 이전 화면에 반영하지 않는다.
      await this.awaitAuthentication(generation, subject)
      return result
    } catch (error) {
      await this.awaitAuthentication(generation, subject)
      throw error
    }
  }
  private refreshSession(forFocus = false): Promise<boolean> {
    const generation = this.generation
    if (this.sessionFlight?.generation === generation) {
      if (!forFocus) this.sessionFlight.commandOwned = true
      return this.sessionFlight.promise
    }
    this.update({ validating: true })
    const flight = { generation, promise: null as unknown as Promise<boolean>, controller: new AbortController(), commandOwned: !forFocus }
    this.sessionFlight = flight
    flight.promise = this.checkSession(generation, flight.controller.signal).finally(() => {
      // 신원을 회수한 뒤 시작된 새 인증의 잠금은 이전 finally가 소유하지 않는다.
      if (this.sessionFlight !== flight) return
      this.sessionFlight = null
      this.update({ validating: false })
    })
    return flight.promise
  }
  private async checkSession(generation: number, signal: AbortSignal): Promise<boolean> {
    let next: Session
    try { next = await this.api.session(signal) }
    catch (error) {
      this.assertCurrent(generation)
      signal.throwIfAborted()
      if (!(error instanceof LoginRequired || (error instanceof ApiFailure && error.loginRequired))) {
        this.quarantine()
        this.update({ notice: error instanceof Error ? error.message : '로그인 정보를 확인할 수 없습니다.' })
      }
      throw error
    }
    this.assertCurrent(generation)
    signal.throwIfAborted()
    if (this.signedOut) throw new DOMException('종료된 인증입니다.', 'AbortError')
    const changed = this.sessionValue !== null && this.sessionValue.subject !== next.subject
    if (changed) this.clear()
    this.sessionValue = next; this.api.csrf = next.csrf
    if (!next.canReview) this.clearReview()
    this.update({ ready: true, canReview: next.canReview, notice: '', retryAfter: null, blocked: false, ...(changed ? { validating: false } : {}) })
    if (changed) void this.task(() => this.loadList())
    return !changed
  }
  private async loadList(after?: string): Promise<void> {
    if (after !== undefined && (this.state.listLoading || this.listCursors.has(after))) return
    if (after === undefined) { this.listRevision++; this.listCursors.clear() }
    const revision = this.listRevision
    const generation = this.generation
    const current = () => revision === this.listRevision && generation === this.generation && !this.disposed
    this.update({ listLoading: true, listFailed: false, ...(after === undefined ? { nextAfter: null } : {}) })
    try {
      const query = new URLSearchParams({ limit: '20' })
      if (after !== undefined) query.set('after', after)
      const list = object(await this.request(`/v1/conversations?${query}`))
      if (!current()) return
      const rows = array(list.items).map(entry => {
        const row = object(entry)
        return { id: text(row.id), title: row.title === null ? null : text(row.title) }
      })
      const next = list.nextAfter === null ? null : text(list.nextAfter)
      const items = after === undefined ? [] : [...this.state.items]
      const ids = new Set(items.map(item => item.id))
      for (const row of rows) if (!ids.has(row.id)) { ids.add(row.id); items.push(row) }
      if (after !== undefined) this.listCursors.add(after)
      // 서버 커서는 해석하지 않고 전달하며 이미 소비한 커서의 순환만 종료한다.
      this.update({ items, nextAfter: next === null || this.listCursors.has(next) ? null : next })
    } catch (error) {
      if (!current()) return
      this.update({ listFailed: true })
      throw error
    } finally { if (current()) this.update({ listLoading: false }) }
  }
  focus = (reopen = false): Promise<void> => {
    if (this.signedOut || this.disposed) return Promise.resolve()
    // 다시 연 화면은 이전 열기의 인증에 의존하지 않는다. 명령과 공유된 인증은 취소하지 않는다.
    if (reopen && this.validation && !this.sessionFlight?.commandOwned) {
      this.sessionFlight?.controller.abort(); this.sessionFlight = null
      this.validation = null; this.focusRevision++
    }
    if (this.validation) {
      if (reopen) this.update({ blocked: true })
      return this.validation
    }
    const revision = ++this.focusRevision
    const blocking = reopen || !this.state.ready
    if (blocking) this.update({ blocked: true })
    const pending = (async () => {
      let same: boolean
      try { same = await this.refreshSession(true) }
      catch (error) {
        if (this.disposed || revision !== this.focusRevision) return
        this.failure(error)
        return
      }
      if (revision !== this.focusRevision) return
      // 인증의 수명은 자료 GET을 기다리지 않는다. 접수된 명령의 자체 갱신과 중복하지 않는다.
      this.update({ blocked: false })
      if (same) await this.task(async () => {
        if (!this.state.busy && !this.pendingUserTasks.has('conversation-reload')) {
          await Promise.all([
            ...(blocking ? [this.task(() => this.loadList())] : []),
            ...(this.state.conversationId && !this.state.job?.active
              ? [this.task(() => this.loadConversation(this.state.conversationId!))] : []),
          ])
        } else if (this.state.busy) this.focusReadPending = true
        const previous = this.state.review.detail
        if (this.state.canReview && previous) {
          const reviewRevision = this.reviewRevision
          const current = () => reviewRevision === this.reviewRevision && revision === this.focusRevision && this.state.review.detail === previous
          const detail = reviewDetail(await this.reviewRequest(`/v1/reviews/${encodeURIComponent(previous.feedback.feedbackId)}`, {}, current))
          if (!current()) return
          const changed = detail.feedback.version !== previous.feedback.version || detail.feedback.state !== previous.feedback.state
          if (changed) this.reviewRevision++
          this.setReview({ detail, ...(changed ? { busy: false, draft: emptyReviewDraft() } : {}) })
        }
      })
    })().finally(() => {
      if (this.validation === pending) this.validation = null
    })
    this.validation = pending
    return pending
  }
  setQuery(value: string): void { this.update({ query: value }) }
  setTab(value: State['tab']): void { this.update({ tab: value }) }
  setSidebar(value: boolean): void {
    this.update({ sidebar: value })
    // 목록에 다시 진입할 때 새 커서 세대로 갱신한다. focus는 누적 페이지를 보존한다.
    if (value && this.state.tab === 'conversation') {
      if (this.listVisited) void this.userTask(() => this.loadList(), { key: 'conversation-list' })
      this.listVisited = true
    }
  }
  private setReview(value: Partial<ReviewState>): void { this.update({ review: { ...this.state.review, ...value } }) }
  private clearReview(): void {
    this.reviewRevision++
    this.update({ review: emptyReview(), tab: this.state.tab === 'review' ? 'conversation' : this.state.tab })
  }
  changeFeedback(jobId: string, comment: string): void {
    const draft = this.state.feedback[jobId] ?? emptyFeedback()
    this.update({ feedback: { ...this.state.feedback, [jobId]: { ...draft, comment } } })
  }
  feedback = (jobId: string, rating: 'UP' | 'DOWN'): Promise<void> => this.userTask(async () => {
    const draft = this.state.feedback[jobId] ?? emptyFeedback()
    if (draft.busy) return
    const set = (value: Partial<FeedbackDraft>) => this.update({ feedback: {
      ...this.state.feedback, [jobId]: { ...(this.state.feedback[jobId] ?? draft), ...value },
    } })
    set({ receipt: null })
    if (characterCount(draft.comment) > 2000) throw new Error('지적: 0~2000자로 입력해 주세요.')
    const generation = this.generation
    set({ busy: true })
    try {
      if (!await this.refreshSession()) return
      const receipt = feedbackReceipt(await this.request(`/v1/answers/${encodeURIComponent(jobId)}/feedback`, {
        method: 'PUT', body: JSON.stringify({ rating, comment: draft.comment }),
      }))
      set({ receipt })
    } catch (error) { throw feedbackError(error) }
    finally { if (generation === this.generation) set({ busy: false }) }
  }, { authenticates: true })
  changeReview(draft: ReviewDraft): void { if (!this.state.review.busy) this.setReview({ draft }) }
  private async reviewAccess(): Promise<void> {
    const revision = this.reviewRevision
    if (!await this.refreshSession() || !this.state.canReview || revision !== this.reviewRevision) {
      throw new DOMException('종료된 검토입니다.', 'AbortError')
    }
  }
  private async reviewRequest(path: string, options: Parameters<AiApi['request']>[1] = {}, current?: () => boolean): Promise<unknown> {
    const revision = this.reviewRevision
    try {
      const result = await this.request(path, options)
      if (revision !== this.reviewRevision || !this.state.canReview || current?.() === false) throw new DOMException('종료된 검토입니다.', 'AbortError')
      return result
    } catch (error) {
      if (revision !== this.reviewRevision || current?.() === false) throw new DOMException('종료된 검토입니다.', 'AbortError')
      if (error instanceof ApiFailure && (error.status === 403 || error.status === 404)) {
        if (error.status === 403) {
          this.clearReview()
          if (error.code === 'REVIEW_FORBIDDEN') this.update({ canReview: false })
        } else this.setReview({ detail: null, draft: emptyReviewDraft() })
      }
      throw error
    }
  }
  private reviewTask(action: () => Promise<void>): Promise<void> {
    return this.userTask(async () => {
      if (this.state.review.busy) return
      const generation = this.generation, revision = this.reviewRevision
      this.setReview({ busy: true })
      try {
        await action()
      } catch (error) { throw feedbackError(error) }
      finally { if (generation === this.generation && revision === this.reviewRevision) this.setReview({ busy: false }) }
    }, { authenticates: true })
  }
  private async loadReviews(after = ''): Promise<void> {
    await this.reviewAccess()
    const query = new URLSearchParams({ state: this.state.review.status, after, limit: '20' })
    const list = reviewList(await this.reviewRequest(`/v1/reviews?${query}`))
    this.setReview(list)
  }
  private async loadReview(id: string): Promise<void> {
    await this.reviewAccess()
    const detail = reviewDetail(await this.reviewRequest(`/v1/reviews/${encodeURIComponent(id)}`))
    this.setReview({ detail, draft: emptyReviewDraft() })
  }
  reviewTab = (): Promise<void> => this.reviewTask(async () => {
    await this.loadReviews()
    this.update({ tab: 'review', sidebar: true })
  })
  reviews = (status: ReviewStatus): Promise<void> => this.reviewTask(async () => {
    this.setReview({ status, items: [], nextAfter: null, detail: null, draft: emptyReviewDraft() })
    await this.loadReviews()
  })
  nextReviews = (): Promise<void> => this.reviewTask(async () => {
    const after = this.state.review.nextAfter
    if (after !== null) { this.setReview({ detail: null, draft: emptyReviewDraft() }); await this.loadReviews(after) }
  })
  openReview = (id: string): Promise<void> => this.reviewTask(async () => {
    this.setReview({ detail: null, draft: emptyReviewDraft() })
    await this.loadReview(id)
  })
  resolveReview = (): Promise<void> => this.reviewTask(async () => {
    await this.reviewAccess()
    const detail = this.state.review.detail
    if (!detail || detail.feedback.state !== 'OPEN') return
    const body = JSON.stringify({ version: detail.feedback.version, cause: this.state.review.draft.cause,
      action: reviewAction(this.state.review.draft, detail) })
    if (new TextEncoder().encode(body).byteLength > 64 * 1024) throw new Error('조치 본문: 64KiB 이내로 입력해 주세요.')
    const id = detail.feedback.feedbackId
    try {
      feedbackReceipt(await this.reviewRequest(`/v1/reviews/${encodeURIComponent(id)}/resolve`, { method: 'POST', body }))
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 409 && error.code === 'REVIEW_CONFLICT') {
        // 충돌한 입력은 새 version에 자동 결속하지 않는다. 새 상세를 보고 다시 입력한다.
        this.setReview({ detail: null, draft: emptyReviewDraft() })
        await this.loadReviews()
        await this.loadReview(id)
      }
      throw error
    }
    this.setReview({ detail: null, draft: emptyReviewDraft() })
    await this.loadReviews()
    await this.loadReview(id)
  })
  next = (): Promise<void> => this.userTask(async () => {
    if (!this.state.listFailed && this.state.nextAfter !== null) await this.loadList(this.state.nextAfter)
  }, { key: 'conversation-next' })
  retryList = (): Promise<void> => this.userTask(async () => {
    if (!this.state.listFailed || this.state.listLoading) return
    this.update({ notice: '', retryAfter: null })
    await this.loadList(this.state.nextAfter ?? undefined)
  }, { key: 'conversation-page-retry' })
  reload = (): Promise<void> => this.userTask(async () => {
    const id = this.state.conversationId
    await Promise.all([
      this.task(() => this.loadList()),
      ...(id && !this.state.job?.active ? [this.task(() => this.loadConversation(id))] : []),
    ])
  }, { key: 'conversation-reload' })

  private async loadConversation(id: string): Promise<void> {
    if (this.state.job?.active) return
    this.detailTarget = id
    const revision = this.conversationRevision, sequence = ++this.detailSequence, generation = this.generation
    const current = () => revision === this.conversationRevision && sequence === this.detailSequence
      && generation === this.generation && !this.disposed && !this.state.job?.active
    this.update({ detailLoading: true, detailFailed: false })
    try {
      const detail = object(await this.request(`/v1/conversations/${encodeURIComponent(id)}`))
      if (!current()) throw new DOMException('종료된 대화입니다.', 'AbortError')
      const conversation = object(detail.conversation)
      const messages = array(detail.messages).map((entry, index) => {
        const message = object(entry)
        const next = { id: text(message.messageId), role: text(message.role),
          content: typeof message.content === 'string' ? message.content : resultView(message.content) }
        const previous = this.state.messages[index]
        // 종결 조회의 임시 ID와 저장된 메시지 ID가 달라도 같은 본문이면 읽던 DOM을 보존한다.
        return previous?.role === next.role && JSON.stringify(previous.content) === JSON.stringify(next.content) ? previous : next
      })
      const denied = messages.some(message => typeof message.content !== 'string' && message.content.denied)
      if (JSON.stringify(messages) !== JSON.stringify(this.state.messages)) {
        this.clearSources()
        this.update({ conversationId: text(conversation.id), messages,
          ...(denied ? { query: '', feedback: {} } : {}) })
      } else this.update({ conversationId: text(conversation.id) })
    } catch (error) {
      if (!current()) throw new DOMException('종료된 대화입니다.', 'AbortError')
      if (error instanceof ApiFailure && (error.status === 404 || error.status === 403)) {
        if (this.state.conversationId === id) {
          this.invalidateConversationReads()
          this.stream?.abort(); this.stream = null
          this.clearSources()
          this.update({ conversationId: null, query: '', messages: [], job: null, progress: [], retry: null, feedback: {}, cancelResult: '' })
        }
      }
      if (current()) this.update({ detailFailed: true })
      throw error
    } finally { if (sequence === this.detailSequence && generation === this.generation) this.update({ detailLoading: false }) }
  }
  open = (id: string): Promise<void> => this.userTask(async () => {
    if (this.state.busy || this.state.job?.active || this.state.retry) return
    this.invalidateConversationReads()
    const revision = this.conversationRevision
    await this.loadConversation(id)
    if (revision !== this.conversationRevision) return
    this.update({ tab: 'conversation', job: null, progress: [], notice: '', cancelResult: '' })
  })
  create = (): Promise<void> => this.command(async () => {
    if (this.state.job?.active || this.state.retry || !await this.refreshSession()) return
    const conversation = object(await this.request('/v1/conversations', { method: 'POST' }))
    this.invalidateConversationReads()
    this.clearSources()
    this.update({ conversationId: text(conversation.id), messages: [], query: '', job: null, progress: [], tab: 'conversation', cancelResult: '' })
    await this.loadList()
  })
  private async command(action: () => Promise<void>): Promise<void> {
    if (this.state.busy || !this.state.ready || this.state.blocked || this.signedOut) return
    const generation = this.generation
    this.update({ busy: true })
    await this.task(action)
    if (generation === this.generation) {
      this.update({ busy: false })
      if (this.focusReadPending) {
        this.focusReadPending = false
        const id = this.state.conversationId
        if (id && !this.state.job?.active) await this.task(() => this.loadConversation(id))
      }
    }
  }
  send = (): Promise<void> => this.command(async () => {
    if (!this.state.query.trim() || this.state.job?.active || this.state.retry) return
    const query = this.state.query, target = this.state.conversationId
    const question = {
      path: target ? `/v1/conversations/${encodeURIComponent(target)}/messages` : '/v1/query',
      body: JSON.stringify({ query, context: questionContext() }), key: crypto.randomUUID(), query,
    }
    this.invalidateConversationReads()
    if (!await this.refreshSession()) return
    await this.admit(question)
  })
  retry = (): Promise<void> => this.command(async () => {
    const question = this.state.retry
    if (question && await this.refreshSession()) await this.admit(question)
  })
  private async admit(question: LogicalQuestion): Promise<void> {
    let accepted: Accepted
    this.invalidateConversationReads()
    this.admission = question
    try {
      accepted = acceptedView(await this.request(question.path, { method: 'POST', body: question.body, key: question.key }))
    } catch (error) {
      if (error instanceof TransportFailure || (error instanceof ApiFailure && error.uncertain)) {
        this.update({ retry: question, notice: '응답을 확인할 수 없습니다. 다시 보내기를 눌러 주세요.' })
        return
      }
      throw error
    } finally { if (this.admission === question) this.admission = null }
    this.clearSources()
    this.update({ retry: null, query: '', conversationId: accepted.conversationId, notice: '',
      messages: [...this.state.messages, { id: accepted.messageId, role: 'user', content: question.query }],
      job: { accepted, active: true, interrupted: false, lastId: '' }, progress: [], cancelResult: '' })
    // 목록 장애가 접수된 Job의 이벤트 연결을 막지 않게 독립 수명으로 시작한다.
    void this.connect()
    await this.loadList()
  }

  reconnect = (): Promise<void> => this.userTask(async () => {
    if (!await this.refreshSession()) return
    await this.loadList()
    await this.connect()
  }, { authenticates: true })
  private connect = (): Promise<void> => this.task(async () => {
    const job = this.state.job
    if (!job || !job.active) return
    const generation = this.generation
    await this.awaitAuthentication(generation, this.sessionValue?.subject)
    if (this.state.job?.accepted.jobId !== job.accepted.jobId) return
    this.stream?.abort()
    const stream = new AbortController()
    this.stream = stream
    this.update({ job: { ...job, interrupted: false }, notice: '' })
    let terminal = false
    let failure: unknown
    try {
      terminal = await readEvents(this.api, job.accepted.jobId, job.lastId, stream.signal, event => {
        this.assertCurrent(generation)
        if (stream.signal.aborted) return
        const current = this.state.job
        if (!current) return
        const ended = terminalEvents.has(event.event)
        this.update({ job: { ...current, lastId: event.id, active: !ended },
          progress: [...this.state.progress, `${event.event} ${event.data}`] })
      })
    } catch (error) { failure = error }
    if (this.disposed || generation !== this.generation || stream.signal.aborted) return
    this.stream = null
    if (failure instanceof LoginRequired || (failure instanceof ApiFailure && failure.identityFailure)) throw failure
    if (terminal) { await this.loadResult(job.accepted.jobId); return }
    if (!await this.refreshSession()) return
    const current = this.state.job
    if (current) this.update({ job: { ...current, interrupted: true }, notice: '연결이 끊겼습니다. 다시 연결하거나 결과를 조회해 주세요.' })
    if (failure !== undefined) this.failure(failure)
  })
  private async loadResult(jobId: string): Promise<void> {
    const revision = this.conversationRevision, sequence = ++this.resultSequence, generation = this.generation
    const current = () => revision === this.conversationRevision && sequence === this.resultSequence
      && generation === this.generation && !this.disposed && this.state.job?.accepted.jobId === jobId
    let result: Result
    this.update({ resultLoading: true, resultFailed: false, ...(!this.state.job?.interrupted ? { notice: '' } : {}) })
    try { result = resultView(await this.request(`/v1/analyses/${encodeURIComponent(jobId)}`)) }
    catch (error) {
      if (!current()) throw new DOMException('종료된 결과입니다.', 'AbortError')
      this.update({ resultFailed: true })
      throw error
    } finally { if (current()) this.update({ resultLoading: false }) }
    if (!current()) throw new DOMException('종료된 결과입니다.', 'AbortError')
    this.invalidateConversationReads()
    if (result.denied) this.clearSources()
    const messages = this.state.messages.filter(message => typeof message.content === 'string' || message.content.jobId !== jobId)
    messages.push({ id: `result-${jobId}`, role: 'assistant', content: result })
    const finished = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(result.jobStatus)
    const job = this.state.job
    if (finished) { this.stream?.abort(); this.stream = null }
    this.update({ messages, job: job && job.accepted.jobId === jobId ? { ...job, active: !finished && job.active, interrupted: !finished && job.interrupted } : job })
  }
  result = (): Promise<void> => this.userTask(async () => {
    if (this.state.job) await this.loadResult(this.state.job.accepted.jobId)
  }, { key: `result:${this.state.job?.accepted.jobId}` })
  cancel = (): Promise<void> => this.userTask(async () => {
    const job = this.state.job
    if (!job?.active) return
    if (!await this.refreshSession() || this.state.job?.accepted.jobId !== job.accepted.jobId || !this.state.job.active) return
    await this.request(`/v1/analyses/${encodeURIComponent(job.accepted.jobId)}/cancel`, { method: 'POST' })
    this.update({ cancelResult: '취소를 요청했습니다.' })
    await this.loadResult(job.accepted.jobId)
  }, { authenticates: true, key: `cancel:${this.state.job?.accepted.jobId}` })
  remove = (id: string): Promise<void> => this.command(async () => {
    if (!window.confirm('대화를 삭제하시겠습니까?') || !await this.refreshSession()) return
    try { await this.request(`/v1/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }) }
    catch (error) {
      if (error instanceof ApiFailure && error.status === 409 && error.code === 'CONVERSATION_ACTIVE') {
        const job = this.state.job
        if (job?.active && job.accepted.conversationId === id) {
          this.update({ notice: '진행 중인 질문을 취소한 뒤 삭제해 주세요.' })
        } else {
          this.update({ notice: '진행 중인 질문이 끝난 뒤 다시 삭제해 주세요.' })
          await this.loadList(); await this.loadConversation(id)
        }
        return
      }
      if (!(error instanceof ApiFailure && error.status === 404)) throw error
    }
    if (this.state.conversationId === id || this.detailTarget === id) this.invalidateConversationReads()
    if (this.state.conversationId === id) {
      this.stream?.abort(); this.stream = null
      this.clearSources()
      this.update({ conversationId: null, messages: [], job: null, progress: [], retry: null, notice: '', cancelResult: '' })
    }
    await this.loadList()
  })
  /** 참고 자료 항목을 그 자리에서 펼치거나 접는다. 여러 항목을 함께 열 수 있다. */
  toggleEvidence = (jobId: string, evidenceId: string): Promise<void> => this.userTask(async () => {
    const key = sourceKey(jobId, evidenceId)
    if (key in this.state.sources) { this.update({ sources: without(this.state.sources, key) }); return }
    const revision = this.sourceRevision
    this.update({ sources: { ...this.state.sources, [key]: null } })
    try {
      const source = object(await this.request(`/v1/analyses/${encodeURIComponent(jobId)}/evidence/${encodeURIComponent(evidenceId)}/source`))
      if (source.resultAccess === 'DENIED') { this.clearSources(); this.update({ notice: '근거를 읽을 권한이 없습니다.' }); return }
      // 그 사이 비우거나 접은 항목은 늦게 도착한 본문으로 되살리지 않는다.
      if (revision === this.sourceRevision && key in this.state.sources) this.update({ sources: { ...this.state.sources, [key]: text(source.maskedText) } })
    } catch (error) {
      if (revision === this.sourceRevision) this.update({ sources: without(this.state.sources, key) })
      throw error
    }
  })
}

function sourceKey(jobId: string, evidenceId: string): string { return `${jobId}/${evidenceId}` }

function without(sources: Record<string, string | null>, key: string): Record<string, string | null> {
  const rest = { ...sources }
  delete rest[key]
  return rest
}

function AnswerView({ result, model }: { result: Result; model: ConversationModel }) {
  const blocked = model.snapshot().validating || model.snapshot().blocked || !model.snapshot().ready
  if (result.denied) return <p>결과를 읽을 권한이 없습니다.</p>
  const exceptional = ['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(result.jobStatus)
  const partial = result.jobStatus === 'PARTIAL' || result.answer?.kind === 'PARTIAL'
  // 실제 부족의 의미는 보존한다. 본문에 이미 있는 안내는 중복 장식으로 붙이지 않는다.
  const partialInBody = result.answer && /일부 자료|확인할 수 없|정리하지 못|최신 자료|확정할 수 없/.test(result.answer.text)
  return <section aria-label="답변">
    {exceptional && <p className="muted">{statusLabel(result.jobStatus)}</p>}
    {!exceptional && !partial && !result.answer && <p className="muted">{statusLabel(result.jobStatus)}</p>}
    {!exceptional && partial && !partialInBody && <p className="muted">일부 자료를 확인할 수 없습니다.</p>}
    {result.answer && <>
      <p className="answer-text">{result.answer.text}</p>
      <Feedback blocked={blocked} draft={model.snapshot().feedback[result.jobId] ?? emptyFeedback()}
        change={comment => model.changeFeedback(result.jobId, comment)} submit={rating => void model.feedback(result.jobId, rating)} />
    </>}
  </section>
}

/** 진행 영역은 답변을 기다리거나 연결이 끊겼거나, 종결됐지만 결과를 아직 받지 못한 동안만 보인다. */
function awaitingResult(job: Job, messages: Message[]): boolean {
  return job.active || job.interrupted
    || !messages.some(message => typeof message.content !== 'string' && message.content.jobId === job.accepted.jobId)
}

function progressLabel(progress: string[], active: boolean): string {
  if (!active) return '답변을 불러오고 있습니다.'
  const event = progress.at(-1)?.split(' ')[0]
  return ({ 'job.queued': '답변을 기다리고 있습니다.', 'job.started': '답변을 준비하고 있습니다.',
    'tool.started': '자료를 확인하고 있습니다.', 'tool.completed': '자료 확인을 마쳤습니다.',
  } as Record<string, string>)[event ?? ''] ?? '답변을 준비하고 있습니다.'
}

export function Conversation({ model, close }: { model: ConversationModel; close: () => void }) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot)
  const sidebarButton = useRef<HTMLButtonElement>(null)
  const sidebar = useRef<HTMLElement>(null)
  const main = useRef<HTMLElement>(null)
  const follow = useRef(true)
  const returnFocus = useRef(false)
  const [narrow, setNarrow] = useState(() => innerWidth < 720)
  const protectedView = state.ready && !state.blocked
  const serverBlocked = state.validating || state.blocked || !state.ready
  const showingSidebar = protectedView && state.sidebar
  const reviewMode = state.tab === 'review' && state.canReview
  useEffect(() => {
    const resize = () => setNarrow(innerWidth < 720)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    if (showingSidebar && narrow) sidebar.current?.querySelector<HTMLButtonElement>('button')?.focus()
    if (!showingSidebar && returnFocus.current) { sidebarButton.current?.focus(); returnFocus.current = false }
  }, [showingSidebar, narrow])
  useEffect(() => {
    if (follow.current && main.current) main.current.scrollTop = main.current.scrollHeight
  }, [state.messages, state.progress])
  useEffect(() => {
    const root = sidebar.current
    if (!showingSidebar || reviewMode || !root) return
    const load = () => {
      // 최소화되거나 감춰진 drawer에서 짧은 목록을 끝까지 미리 읽지 않는다.
      if (root.clientHeight > 0 && root.getClientRects().length > 0
        && root.scrollHeight - root.scrollTop - root.clientHeight < 80) void model.next()
    }
    root.addEventListener('scroll', load)
    const observer = new ResizeObserver(load)
    observer.observe(root)
    load()
    return () => { root.removeEventListener('scroll', load); observer.disconnect() }
  }, [model, showingSidebar, reviewMode, state.items, state.nextAfter, state.listLoading, state.listFailed, state.validating])
  const closeSidebar = () => { returnFocus.current = true; model.setSidebar(false) }
  const locked = state.busy || Boolean(state.job?.active) || state.retry !== null
  return <section className={`panel${showingSidebar ? ' expanded' : ''}`} aria-label="AI 대화">
    {showingSidebar && <>
      {narrow && <div className="drawer-backdrop" onClick={closeSidebar} />}
      <aside ref={sidebar} aria-label={reviewMode ? '검토 사이드바' : '대화 사이드바'} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); closeSidebar() }
        if (event.key !== 'Tab' || !narrow) return
        const controls = Array.from(sidebar.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),a[href]') ?? [])
        const active = sidebar.current?.getRootNode() instanceof ShadowRoot ? (sidebar.current.getRootNode() as ShadowRoot).activeElement : document.activeElement
        if (event.shiftKey && active === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
        else if (!event.shiftKey && active === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
      }}>
        <div className="aside-heading"><strong>{reviewMode ? '검토 목록' : '대화 목록'}</strong><button className="icon-button" aria-label="목록 닫기" title="목록 닫기" onClick={closeSidebar}><Icon name="close" /></button></div>
        {reviewMode ? <ReviewList state={{ ...state.review, busy: state.review.busy || serverBlocked }} list={status => void model.reviews(status)} next={() => void model.nextReviews()} open={id => { void model.openReview(id); if (narrow) closeSidebar() }} />
          : <section aria-label="대화 목록" aria-busy={state.listLoading}>
            {state.items.length === 0 && !state.listLoading && !state.listFailed && <p className="muted">대화가 없습니다.</p>}
            {state.items.map(item => <article className="conversation-row" key={item.id}>
              <button aria-current={state.conversationId === item.id ? 'true' : undefined} disabled={locked || serverBlocked} onClick={() => { void model.open(item.id); if (narrow) closeSidebar() }}>{item.title ?? '새 대화'}</button>
              <button className="delete-button" aria-label={`${item.title ?? '새 대화'} 삭제`} disabled={state.busy || serverBlocked} onClick={() => void model.remove(item.id)}>삭제</button>
            </article>)}
            {state.listLoading && <p role="status" className="muted">대화 목록을 불러오고 있습니다.</p>}
            {state.listFailed && <button disabled={serverBlocked} onClick={() => void model.retryList()}>목록 다시 시도</button>}
            {state.detailLoading && <p role="status" className="muted">대화 내용을 불러오고 있습니다.</p>}
            {state.detailFailed && <p role="alert">대화 내용을 불러오지 못했습니다. 다시 새로고침해 주세요.</p>}
            <button className="reload-button" disabled={serverBlocked} onClick={() => void model.reload()}>목록·상세 새로고침</button>
          </section>}
      </aside>
    </>}
    <div className="chat-column" inert={showingSidebar && narrow}>
      <header>
        <button ref={sidebarButton} className="icon-button" aria-label={reviewMode ? '검토 목록' : '대화 목록'} aria-expanded={showingSidebar} title="목록 열기" disabled={!protectedView} onClick={() => model.setSidebar(!state.sidebar)}><Icon name="sidebar" /></button>
        <strong>Nori AI</strong>
        {!reviewMode && <button className="icon-button" aria-label="새 대화" title="새 대화" disabled={!protectedView || locked || serverBlocked} onClick={() => void model.create()}><Icon name="new" /></button>}
        <button className="icon-button" aria-label="AI 대화 최소화" title="최소화" onClick={close}><Icon name="close" /></button>
      </header>
      {protectedView && state.canReview && <nav className="mode-switch" aria-label="작업 모드">
        <button aria-pressed={!reviewMode} onClick={() => model.setTab('conversation')}>대화</button>
        <button aria-pressed={reviewMode} disabled={state.review.busy || serverBlocked} onClick={() => void model.reviewTab()}>검토</button>
      </nav>}
      {state.validating && state.blocked && <p role="status" className="session-status">로그인 정보를 확인하고 있습니다.</p>}
      {state.notice && <p role="alert">{state.notice}</p>}
      {state.retryAfter && <p className="session-status">다시 시도할 수 있는 시간: {state.retryAfter}초 후</p>}
      <main ref={main} onScroll={() => { const node = main.current; if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48 }}>
        {protectedView && (reviewMode ? <Review blocked={serverBlocked} state={state.review} change={draft => model.changeReview(draft)} submit={() => void model.resolveReview()} /> : <>
          {state.messages.length === 0 && <div className="welcome"><div className="welcome-icon"><Icon name="chat" /></div><h2>무엇을 도와드릴까요?</h2><p className="muted">업무에 필요한 내용을 질문해 주세요.</p></div>}
          <section aria-label="대화 내용">
            {state.messages.map(message => <article className={message.role === 'user' ? 'message-user' : 'message-assistant'} key={message.id}>
              {typeof message.content === 'string' ? <p className="answer-text">{message.content}</p> : <AnswerView result={message.content} model={model} />}
            </article>)}
          </section>
          {state.job && awaitingResult(state.job, state.messages) && <section className="job-status" aria-label="질문 진행">
            {!state.job.interrupted && !state.resultFailed && <div role="log" aria-live="polite" aria-atomic="true">{state.resultLoading ? '답변을 불러오고 있습니다.' : progressLabel(state.progress, state.job.active)}</div>}
            {state.job.interrupted && state.job.active && <button disabled={serverBlocked} onClick={() => void model.reconnect()}>다시 연결</button>}
            {(state.job.interrupted || state.resultFailed) && <button disabled={serverBlocked || state.resultLoading} onClick={() => void model.result()}>결과 다시 조회</button>}
          </section>}
          {state.cancelResult && <p>{state.cancelResult}</p>}
        </>)}
      </main>
      {protectedView && !reviewMode && <footer>
        <div className="composer"><textarea aria-label="질문" placeholder="질문을 입력해 주세요" value={state.query} disabled={locked} onChange={event => model.setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!locked && !serverBlocked) { follow.current = true; void model.send() } }
        }} />
          <button className="send-button icon-button" aria-label="보내기" title="보내기" disabled={locked || serverBlocked || !state.query.trim()} onClick={() => { follow.current = true; void model.send() }}><Icon name="send" /></button>
        </div>
        <div className="composer-hint"><span>Enter로 전송 · Shift+Enter로 줄바꿈</span>
          {state.job?.active && <button disabled={serverBlocked} onClick={() => void model.cancel()}>취소</button>}
          {state.retry && <button disabled={state.busy || serverBlocked} onClick={() => void model.retry()}>다시 보내기</button>}
        </div>
      </footer>}
    </div>
  </section>
}
