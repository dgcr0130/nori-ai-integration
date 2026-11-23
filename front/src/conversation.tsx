import { useEffect, useSyncExternalStore } from 'react'
import { AiApi, ApiFailure, LoginRequired, TransportFailure, object, questionContext, text, type Session } from './api'
import { readEvents, terminalEvents } from './stream'
import { Feedback, emptyFeedback, characterCount, feedbackReceipt, feedbackError, type FeedbackDraft } from './feedback'
import { Review, emptyReview, emptyReviewDraft, reviewList, reviewDetail, reviewAction, type ReviewState, type ReviewStatus, type ReviewDraft } from './review'

interface Accepted { jobId: string; conversationId: string; messageId: string; queuePosition: number }
interface LogicalQuestion { path: string; body: string; key: string; query: string }
interface ConversationEntry { id: string; title: string | null }
interface Citation { number: number; evidenceId: string; sourceType: string; location: unknown }
interface Answer { kind: string; text: string; citations: Citation[] }
interface Block { id: string; value: Record<string, unknown> }
interface Result { jobId: string; jobStatus: string; answer: Answer | null; blocks: Block[]; denied: boolean }
interface Message { id: string; role: string; content: string | Result }
interface Job { accepted: Accepted; active: boolean; lastId: string; interrupted: boolean }
interface State {
  tab: 'conversation' | 'list' | 'review'; query: string; conversationId: string | null
  items: ConversationEntry[]; nextAfter: string | null; messages: Message[]
  job: Job | null; retry: LogicalQuestion | null; progress: string[]
  notice: string; retryAfter: string | null; evidence: string; exported: string
  busy: boolean; ready: boolean; cancelResult: string
  canReview: boolean; review: ReviewState; feedback: Record<string, FeedbackDraft>
}

const initialState = (): State => ({
  tab: 'conversation', query: '', conversationId: null, items: [], nextAfter: null, messages: [],
  job: null, retry: null, progress: [], notice: '', retryAfter: null, evidence: '', exported: '',
  busy: false, ready: false, cancelResult: '',
  canReview: false, review: emptyReview(), feedback: {},
})

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('응답 형식을 확인할 수 없습니다.')
  return value
}

function resultView(value: unknown): Result {
  const root = object(value)
  const result = root.result === null || root.result === undefined ? null : object(root.result)
  const payload = result === null ? null : object(result.payload)
  const answer = payload?.answer === undefined || payload.answer === null ? null : object(payload.answer)
  return {
    jobId: text(root.jobId), jobStatus: text(root.jobStatus), denied: root.resultAccess === 'DENIED',
    answer: answer === null ? null : {
      kind: text(answer.kind), text: text(answer.text),
      citations: array(answer.citations).map(entry => {
        const citation = object(entry)
        if (typeof citation.number !== 'number') throw new Error('응답 형식을 확인할 수 없습니다.')
        return { number: citation.number, evidenceId: text(citation.evidenceId), sourceType: text(citation.sourceType), location: citation.location }
      }),
    },
    blocks: payload?.blocks === undefined ? [] : array(payload.blocks).map(entry => {
      const block = object(entry)
      return { id: text(block.id), value: block }
    }),
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
  private exportRevision = 0
  private reviewRevision = 0

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
    this.sourceRevision++; this.exportRevision++
    this.reviewRevision++
    this.stream?.abort(); this.stream = null
    this.api.cancelAll(); this.sessionValue = null
    this.state = initialState()
  }
  dispose(): void {
    this.clear(); this.api.dispose(); this.disposed = true; this.listeners.clear()
  }
  private clearSources(): void {
    this.sourceRevision++; this.exportRevision++
    this.update({ evidence: '', exported: '' })
  }
  private failure(error: unknown): void {
    if (this.disposed || (error instanceof DOMException && error.name === 'AbortError')) return
    if (error instanceof LoginRequired || (error instanceof ApiFailure && error.identityFailure)) {
      this.clear()
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
  private async request(path: string, options: Parameters<AiApi['request']>[1] = {}): Promise<unknown> {
    const generation = this.generation
    const result = await this.api.request(path, options)
    this.assertCurrent(generation)
    return result
  }
  private async refreshSession(): Promise<boolean> {
    const generation = this.generation
    const next = await this.api.session()
    this.assertCurrent(generation)
    const changed = this.sessionValue !== null && this.sessionValue.subject !== next.subject
    if (changed) this.clear()
    this.sessionValue = next; this.api.csrf = next.csrf
    if (!next.canReview) this.clearReview()
    this.update({ ready: true, canReview: next.canReview, notice: '', retryAfter: null })
    if (changed) await this.loadList()
    return !changed
  }
  private async loadList(after?: string): Promise<void> {
    const query = new URLSearchParams({ limit: '20' })
    if (after !== undefined) query.set('after', after)
    const list = object(await this.request(`/v1/conversations?${query}`))
    const items = array(list.items).map(entry => {
      const row = object(entry)
      return { id: text(row.id), title: row.title === null ? null : text(row.title) }
    })
    this.update({ items, nextAfter: list.nextAfter === null ? null : text(list.nextAfter) })
  }
  initialize = (): Promise<void> => this.task(async () => { await this.refreshSession(); await this.loadList() })
  focus = (): Promise<void> => this.task(async () => {
    if (await this.refreshSession()) await this.loadList()
  })
  setQuery(value: string): void { this.update({ query: value }) }
  setTab(value: State['tab']): void { this.update({ tab: value }) }
  private setReview(value: Partial<ReviewState>): void { this.update({ review: { ...this.state.review, ...value } }) }
  private clearReview(): void {
    this.reviewRevision++
    this.update({ review: emptyReview(), tab: this.state.tab === 'review' ? 'conversation' : this.state.tab })
  }
  changeFeedback(jobId: string, comment: string): void {
    const draft = this.state.feedback[jobId] ?? emptyFeedback()
    this.update({ feedback: { ...this.state.feedback, [jobId]: { ...draft, comment } } })
  }
  feedback = (jobId: string, rating: 'UP' | 'DOWN'): Promise<void> => this.task(async () => {
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
  })
  changeReview(draft: ReviewDraft): void { if (!this.state.review.busy) this.setReview({ draft }) }
  private async reviewAccess(): Promise<void> {
    const revision = this.reviewRevision
    if (!await this.refreshSession() || !this.state.canReview || revision !== this.reviewRevision) {
      throw new DOMException('종료된 검토입니다.', 'AbortError')
    }
  }
  private async reviewRequest(path: string, options: Parameters<AiApi['request']>[1] = {}): Promise<unknown> {
    const revision = this.reviewRevision
    try {
      const result = await this.request(path, options)
      if (revision !== this.reviewRevision || !this.state.canReview) throw new DOMException('종료된 검토입니다.', 'AbortError')
      return result
    } catch (error) {
      if (revision !== this.reviewRevision) throw new DOMException('종료된 검토입니다.', 'AbortError')
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
    return this.task(async () => {
      if (this.state.review.busy) return
      const generation = this.generation, revision = this.reviewRevision
      this.setReview({ busy: true })
      try {
        await action()
      } catch (error) { throw feedbackError(error) }
      finally { if (generation === this.generation && revision === this.reviewRevision) this.setReview({ busy: false }) }
    })
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
    this.update({ tab: 'review' })
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
  next = (): Promise<void> => this.task(async () => {
    if (this.state.nextAfter !== null) await this.loadList(this.state.nextAfter)
  })
  reload = (): Promise<void> => this.task(async () => {
    await this.loadList()
    if (this.state.conversationId) await this.loadConversation(this.state.conversationId)
  })

  private async loadConversation(id: string): Promise<void> {
    this.clearSources()
    try {
      const detail = object(await this.request(`/v1/conversations/${encodeURIComponent(id)}`))
      const conversation = object(detail.conversation)
      const messages = array(detail.messages).map(entry => {
        const message = object(entry)
        return { id: text(message.messageId), role: text(message.role),
          content: typeof message.content === 'string' ? message.content : resultView(message.content) }
      })
      this.update({ conversationId: text(conversation.id), messages, evidence: '', exported: '' })
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) {
        if (this.state.conversationId === id) this.update({ conversationId: null, messages: [], evidence: '', exported: '' })
      }
      throw error
    }
  }
  open = (id: string): Promise<void> => this.task(async () => {
    if (this.state.busy || this.state.job?.active || this.state.retry) return
    await this.loadConversation(id)
    this.update({ tab: 'conversation', job: null, progress: [], notice: '', cancelResult: '' })
  })
  create = (): Promise<void> => this.command(async () => {
    if (this.state.job?.active || this.state.retry || !await this.refreshSession()) return
    const conversation = object(await this.request('/v1/conversations', { method: 'POST' }))
    this.clearSources()
    this.update({ conversationId: text(conversation.id), messages: [], query: '', job: null, progress: [], evidence: '', exported: '', tab: 'conversation', cancelResult: '' })
    await this.loadList()
  })
  private async command(action: () => Promise<void>): Promise<void> {
    if (this.state.busy) return
    const generation = this.generation
    this.update({ busy: true })
    await this.task(action)
    if (generation === this.generation) this.update({ busy: false })
  }
  send = (): Promise<void> => this.command(async () => {
    if (!this.state.query.trim() || this.state.job?.active || this.state.retry || !await this.refreshSession()) return
    const query = this.state.query
    const question = {
      path: this.state.conversationId ? `/v1/conversations/${encodeURIComponent(this.state.conversationId)}/messages` : '/v1/query',
      body: JSON.stringify({ query, context: questionContext() }), key: crypto.randomUUID(), query,
    }
    await this.admit(question)
  })
  retry = (): Promise<void> => this.command(async () => {
    const question = this.state.retry
    if (question && await this.refreshSession()) await this.admit(question)
  })
  private async admit(question: LogicalQuestion): Promise<void> {
    let accepted: Accepted
    try {
      accepted = acceptedView(await this.request(question.path, { method: 'POST', body: question.body, key: question.key }))
    } catch (error) {
      if (error instanceof TransportFailure || (error instanceof ApiFailure && error.uncertain)) {
        this.update({ retry: question, notice: '응답을 확인할 수 없습니다. 다시 보내기를 눌러 주세요.' })
        return
      }
      throw error
    }
    this.clearSources()
    this.update({ retry: null, query: '', conversationId: accepted.conversationId, notice: '',
      messages: [...this.state.messages, { id: accepted.messageId, role: 'user', content: question.query }],
      job: { accepted, active: true, interrupted: false, lastId: '' }, progress: [], evidence: '', exported: '', cancelResult: '' })
    // 목록 장애가 접수된 Job의 이벤트 연결을 막지 않게 독립 수명으로 시작한다.
    void this.connect()
    await this.loadList()
  }

  reconnect = (): Promise<void> => this.task(async () => {
    if (!await this.refreshSession()) return
    await this.loadList()
    await this.connect()
  })
  private connect = (): Promise<void> => this.task(async () => {
    const job = this.state.job
    if (!job || !job.active) return
    this.stream?.abort()
    const stream = new AbortController()
    this.stream = stream
    const generation = this.generation
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
    const result = resultView(await this.request(`/v1/analyses/${encodeURIComponent(jobId)}`))
    if (result.denied) this.clearSources()
    const messages = this.state.messages.filter(message => typeof message.content === 'string' || message.content.jobId !== jobId)
    messages.push({ id: `result-${jobId}`, role: 'assistant', content: result })
    const finished = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(result.jobStatus)
    const job = this.state.job
    if (finished) { this.stream?.abort(); this.stream = null }
    this.update({ messages, job: job && job.accepted.jobId === jobId ? { ...job, active: !finished && job.active, interrupted: !finished && job.interrupted } : job })
  }
  result = (): Promise<void> => this.task(async () => {
    if (this.state.job) await this.loadResult(this.state.job.accepted.jobId)
  })
  cancel = (): Promise<void> => this.task(async () => {
    const job = this.state.job
    if (!job?.active) return
    await this.request(`/v1/analyses/${encodeURIComponent(job.accepted.jobId)}/cancel`, { method: 'POST' })
    this.update({ cancelResult: '취소 요청: HTTP 204' })
    await this.loadResult(job.accepted.jobId)
  })
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
    if (this.state.conversationId === id) {
      this.stream?.abort(); this.stream = null
      this.clearSources()
      this.update({ conversationId: null, messages: [], job: null, progress: [], retry: null, evidence: '', exported: '', notice: '', cancelResult: '' })
    }
    await this.loadList()
  })
  evidence = (jobId: string, evidenceId: string): Promise<void> => this.task(async () => {
    const revision = ++this.sourceRevision
    this.update({ evidence: '' })
    const source = object(await this.request(`/v1/analyses/${encodeURIComponent(jobId)}/evidence/${encodeURIComponent(evidenceId)}/source`))
    if (source.resultAccess === 'DENIED') { this.clearSources(); this.update({ notice: '근거를 읽을 권한이 없습니다.' }); return }
    if (revision !== this.sourceRevision) return
    this.update({ evidence: text(source.maskedText) })
  })
  export = (jobId: string, blockId: string): Promise<void> => this.task(async () => {
    const revision = ++this.exportRevision
    this.update({ exported: '' })
    const block = object(await this.request(`/v1/analyses/${encodeURIComponent(jobId)}/blocks/${encodeURIComponent(blockId)}/export`))
    if (block.resultAccess === 'DENIED') { this.clearSources(); this.update({ notice: '근거를 읽을 권한이 없습니다.' }); return }
    if (revision !== this.exportRevision) return
    this.update({ exported: JSON.stringify(block, null, 2) })
  })
}

function AnswerView({ result, model }: { result: Result; model: ConversationModel }) {
  if (result.denied) return <p>결과를 읽을 권한이 없습니다.</p>
  return <section aria-label="답변">
    <p>{result.jobStatus}</p>
    {result.answer && <>
      <p>{result.answer.kind === 'NO_EVIDENCE' ? '근거 없음' : result.answer.kind}</p>
      <p className="answer-text">{result.answer.text}</p>
      {result.answer.citations.map(citation => <div key={citation.number}>
        <button onClick={() => void model.evidence(result.jobId, citation.evidenceId)}>근거 {citation.number}</button>
        <span>{citation.sourceType} {JSON.stringify(citation.location)}</span>
      </div>)}
      <Feedback draft={model.snapshot().feedback[result.jobId] ?? emptyFeedback()}
        change={comment => model.changeFeedback(result.jobId, comment)} submit={rating => void model.feedback(result.jobId, rating)} />
    </>}
    {result.blocks.map(block => <div key={block.id}>
      <pre>{JSON.stringify(block.value, null, 2)}</pre>
      <button onClick={() => void model.export(result.jobId, block.id)}>내보내기 {block.id}</button>
    </div>)}
  </section>
}

export function Conversation({ model, close }: { model: ConversationModel; close: () => void }) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot)
  useEffect(() => {
    void model.initialize()
    const focus = () => { void model.focus() }
    window.addEventListener('focus', focus)
    return () => { window.removeEventListener('focus', focus); model.dispose() }
  }, [model])
  const locked = state.busy || Boolean(state.job?.active) || state.retry !== null
  return <section className="panel" aria-label="AI 대화">
    <header><strong>AI 대화</strong><button onClick={close}>닫기</button></header>
    <nav aria-label="탭">
      <button aria-pressed={state.tab === 'conversation'} onClick={() => model.setTab('conversation')}>대화</button>
      <button aria-pressed={state.tab === 'list'} onClick={() => model.setTab('list')}>대화 목록</button>
      {state.canReview && <button aria-pressed={state.tab === 'review'} disabled={state.review.busy} onClick={() => void model.reviewTab()}>검토</button>}
      <button disabled={!state.ready || locked} onClick={() => void model.create()}>새 대화</button>
    </nav>
    {state.notice && <p role="alert">{state.notice}</p>}
    {state.retryAfter && <p>Retry-After: {state.retryAfter}</p>}
    <main>
      {state.ready && state.canReview && state.tab === 'review' && <Review state={state.review}
        list={status => void model.reviews(status)} next={() => void model.nextReviews()} open={id => void model.openReview(id)}
        change={draft => model.changeReview(draft)} submit={() => void model.resolveReview()} />}
      {state.ready && state.tab === 'list' && <section aria-label="대화 목록">
        {state.items.length === 0 && <p>대화가 없습니다.</p>}
        {state.items.map(item => <article key={item.id}>
          <button disabled={locked} onClick={() => void model.open(item.id)}>{item.title ?? '새 대화'}</button>
          <button aria-label={`${item.title ?? '새 대화'} 삭제`} disabled={state.busy} onClick={() => void model.remove(item.id)}>삭제</button>
        </article>)}
        {state.nextAfter !== null && <button onClick={() => void model.next()}>다음 쪽</button>}
        <button onClick={() => void model.reload()}>목록·상세 새로고침</button>
      </section>}
      {state.ready && state.tab === 'conversation' && <section aria-label="대화 내용">
        {state.messages.map(message => <article key={message.id}>
          <p>{message.role}</p>
          {typeof message.content === 'string' ? <p className="answer-text">{message.content}</p> : <AnswerView result={message.content} model={model} />}
        </article>)}
      </section>}
      {state.job && <section aria-label="질문 진행">
        <p>jobId: {state.job.accepted.jobId}</p><p>conversationId: {state.job.accepted.conversationId}</p>
        <p>messageId: {state.job.accepted.messageId}</p><p>queuePosition: {state.job.accepted.queuePosition}</p>
        <div role="log">{state.progress.map((event, index) => <p key={index}>{event}</p>)}</div>
        {state.job.interrupted && state.job.active && <button onClick={() => void model.reconnect()}>다시 연결</button>}
        <button onClick={() => void model.result()}>결과 다시 조회</button>
      </section>}
      {state.cancelResult && <p>{state.cancelResult}</p>}
      {state.evidence && <pre aria-label="근거 본문">{state.evidence}</pre>}
      {state.exported && <section aria-label="내보내기 결과"><pre>{state.exported}</pre>
        <a download="nori-ai-block.json" href={`data:application/json;charset=utf-8,${encodeURIComponent(state.exported)}`}>다운로드</a>
      </section>}
    </main>
    <footer>
      <label>질문<textarea value={state.query} disabled={!state.ready || locked} onChange={event => model.setQuery(event.target.value)} /></label>
      <button disabled={!state.ready || locked || !state.query.trim()} onClick={() => void model.send()}>보내기</button>
      <button disabled={!state.job?.active} onClick={() => void model.cancel()}>취소</button>
      {state.retry && <button disabled={state.busy} onClick={() => void model.retry()}>다시 보내기</button>}
    </footer>
  </section>
}
