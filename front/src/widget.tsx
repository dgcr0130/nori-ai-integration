import { createRoot, type Root } from 'react-dom/client'

declare const __INTEGRATION_VERSION__: string

class NoriAiWidget extends HTMLElement {
  #root: Root | undefined

  get integrationVersion(): string {
    return __INTEGRATION_VERSION__
  }

  connectedCallback(): void {
    if (this.#root) return
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' })
    this.#root = createRoot(shadow)
    // 대화 UI는 후속 phase가 소유하므로 이 단계는 자산과 React 수명만 제공한다.
    this.#root.render(null)
  }

  disconnectedCallback(): void {
    this.#root?.unmount()
    this.#root = undefined
  }
}

if (!customElements.get('nori-ai-widget')) {
  customElements.define('nori-ai-widget', NoriAiWidget)
}
