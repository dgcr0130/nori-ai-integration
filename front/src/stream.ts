import { AiApi } from './api'

export interface JobEvent { id: string; event: string; data: string }
export const terminalEvents = new Set(['job.completed', 'job.partial', 'job.failed', 'job.cancelled'])

// 쿠키 방식도 fetch를 써서 브라우저의 자동 재접속과 별도 커서 전달 경로를 만들지 않는다.
export async function readEvents(api: AiApi, jobId: string, lastId: string, signal: AbortSignal,
  receive: (event: JobEvent) => void): Promise<boolean> {
  return api.consume(`/v1/analyses/${encodeURIComponent(jobId)}/events`, {
    accept: 'text/event-stream', lastId, signal,
  }, async response => {
    if (!(response.headers.get('Content-Type') ?? '').includes('text/event-stream') || !response.body) {
      throw new Error('이벤트 응답 형식을 확인할 수 없습니다.')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let line = '', id = lastId, event = '', data: string[] = [], afterCR = false
    const dispatch = () => {
      if (data.length === 0) { event = ''; return false }
      const current = { id, event: event || 'message', data: data.join('\n') }
      receive(current)
      event = ''; data = []
      return terminalEvents.has(current.event)
    }
    const acceptLine = () => {
      if (line === '') return dispatch()
      if (!line.startsWith(':')) {
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'id' && !value.includes('\0')) id = value
        if (field === 'event') event = value
        if (field === 'data') data.push(value)
      }
      line = ''
      return false
    }
    try {
      while (!signal.aborted) {
        const chunk = await reader.read()
        const content = decoder.decode(chunk.value, { stream: !chunk.done })
        for (const character of content) {
          if (afterCR && character === '\n') { afterCR = false; continue }
          afterCR = character === '\r'
          if (character === '\r' || character === '\n') {
            if (acceptLine()) return true
          } else line += character
        }
        if (chunk.done) return false
      }
      return false
    } finally {
      try { await reader.cancel() } finally { reader.releaseLock() }
    }
  })
}
