import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'

function Host() {
  const [count, setCount] = useState(0)
  return React.createElement('section', null,
    React.createElement('h1', null, `쿠키 호스트 React ${React.version}`),
    React.createElement('a', { href: '/login' }, '쿠키 로그인'),
    React.createElement('button', { onClick: () => setCount(count + 1) }, `호스트 ${count}`),
    React.createElement('nori-ai-widget'),
  )
}
createRoot(document.getElementById('host')).render(React.createElement(Host))
