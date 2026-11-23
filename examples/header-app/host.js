import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

function Host() {
  const widget = useRef(null)
  const token = useRef(null)
  const [count, setCount] = useState(0)
  useEffect(() => {
    const element = widget.current
    element.requestHeaders = () => {
      // 값은 위젯에 저장하지 않고 매 요청마다 현재 로그인 자격을 읽는다.
      element.dispatchEvent(new Event('example-request-headers'))
      return { Authorization: `Bearer ${token.current.value}` }
    }
    return () => { element.requestHeaders = undefined }
  }, [])
  return React.createElement('section', null,
    React.createElement('h1', null, `헤더 호스트 React ${React.version}`),
    React.createElement('label', null, '예제 로그인 토큰', React.createElement('input', { type: 'password', ref: token })),
    React.createElement('button', { onClick: () => setCount(count + 1) }, `호스트 ${count}`),
    React.createElement('nori-ai-widget', { ref: widget, 'api-base': '/prefix/api/ai' }),
  )
}
createRoot(document.getElementById('host')).render(React.createElement(Host))
