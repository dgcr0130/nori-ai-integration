const labels: Record<string, string> = {
  text: '내용', bodyMasked: '근거 본문', maskedText: '근거 본문', sourceType: '출처',
  bucket: '보관함', objectKey: '문서', revision: '문서 판본', section: '절', lineFrom: '시작 줄', lineTo: '끝 줄',
  location: '위치', note: '조치 메모', cause: '원인', action: '조치', createdAt: '등록일', updatedAt: '변경일',
  sentences: '정답 문장', citations: '인용', number: '번호', expectedFacts: '핵심 사실', locations: '문서 위치',
  correctAnswer: '정답', terms: '용어', question: '질문', answer: '답변', title: '제목', content: '내용',
  description: '설명', exampleQuestions: '예시 질문',
}
export const statusLabel = (value: string): string => ({
  OPEN: '검토 대기', RESOLVED: '처리 완료', REJECTED: '반려', SUCCEEDED: '답변이 완료되었습니다.',
  PARTIAL: '일부 답변이 완료되었습니다.', FAILED: '답변 처리 중 오류가 발생했습니다.', CANCELLED: '질문이 취소되었습니다.',
  TIMED_OUT: '답변 대기 시간이 초과되었습니다.', QUEUED: '답변을 기다리고 있습니다.', RUNNING: '답변을 준비하고 있습니다.',
  DOCUMENT: '문서', RETRIEVAL: '자료 검색', ANSWER: '답변', REJECT: '반려', SYSTEM: '실시간 자료',
  UP: '도움이 됨', DOWN: '도움이 안 됨',
}[value] ?? value)

// 서버 자료는 React 텍스트 노드만 사용하며 식별자·원시 JSON을 일반 본문에 노출하지 않는다.
export function ReadableValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <p className="muted">없음</p>
  if (Array.isArray(value)) return value.length ? <div className="readable-list">{value.map((entry, index) => <div key={index}><ReadableValue value={entry} /></div>)}</div> : <p className="muted">없음</p>
  if (typeof value === 'object') return <dl>{Object.entries(value).filter(([key]) => !/Id$|^id$|Ref$|^version$|^kind$/.test(key)).map(([key, entry]) =>
    <div key={key}><dt>{labels[key] ?? '자료'}</dt><dd><ReadableValue value={entry} /></dd></div>)}</dl>
  return <p className="answer-text">{typeof value === 'string' ? statusLabel(value) : String(value)}</p>
}
