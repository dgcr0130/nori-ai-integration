import * as React from 'react'
import { createRoot } from 'react-dom/client'

// 위젯과 별도로 번들링하므로 호스트 hooks와 위젯 hooks는 인스턴스를 공유하지 않는다.
Reflect.set(window, 'hostReact', React)
function Host() {
  const [count, setCount] = React.useState(0)
  return React.createElement('section', null,
    React.createElement('button', { id: 'host-counter', onClick: () => setCount(count + 1) }, `호스트 ${count}`),
    React.createElement('nori-ai-widget', { 'api-base': document.documentElement.dataset.apiBase }),
  )
}
const container = document.getElementById('host')
if (!container) throw new Error('호스트 영역이 없습니다.')
createRoot(container).render(React.createElement(Host))
