import { createRoot, type Root } from 'react-dom/client'
import { AiApi, apiBase, type RequestHeaders } from './api'
import { Conversation, ConversationModel } from './conversation'
import styles from './styles.css?inline'

declare const __INTEGRATION_VERSION__: string

class NoriAiWidget extends HTMLElement {
  #root: Root | undefined
  #model: ConversationModel | undefined
  #frame: HTMLDivElement | undefined
  #mount: HTMLDivElement | undefined
  #launcher: HTMLButtonElement | undefined
  declare requestHeaders?: RequestHeaders

  get integrationVersion(): string {
    return __INTEGRATION_VERSION__
  }

  connectedCallback(): void {
    if (this.#frame) return
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = styles
    this.#frame = document.createElement('div')
    this.#frame.className = 'frame'
    this.#launcher = document.createElement('button')
    this.#launcher.className = 'launcher'
    this.#launcher.textContent = 'AI 열기'
    this.#launcher.addEventListener('click', this.#open)
    this.#mount = document.createElement('div')
    this.#frame.append(this.#launcher, this.#mount)
    shadow.append(style, this.#frame)
    this.#layout()
  }

  disconnectedCallback(): void {
    this.#close()
    window.removeEventListener('resize', this.#layout)
    this.#launcher?.removeEventListener('click', this.#open)
    this.shadowRoot?.replaceChildren()
    this.#frame = undefined; this.#mount = undefined; this.#launcher = undefined
  }

  #open = (): void => {
    if (this.#root || !this.#mount) return
    this.#layout()
    if (this.#launcher) this.#launcher.hidden = true
    this.#model = new ConversationModel(new AiApi(this, apiBase(this.getAttribute('api-base'))))
    this.#root = createRoot(this.#mount)
    this.#root.render(<Conversation model={this.#model} close={this.#close} />)
    window.addEventListener('resize', this.#layout)
  }

  #close = (): void => {
    window.removeEventListener('resize', this.#layout)
    this.#model?.dispose()
    this.#root?.unmount()
    this.#root = undefined; this.#model = undefined
    if (this.#launcher) this.#launcher.hidden = false
  }

  #layout = (): void => {
    if (!this.#frame) return
    this.#frame.classList.toggle('left', this.getAttribute('position') === 'bottom-left')
    const computed = getComputedStyle(this)
    this.#frame.style.setProperty('--width', this.#length(computed.getPropertyValue('--nori-ai-width').trim(), 400, innerWidth - 32))
    this.#frame.style.setProperty('--height', this.#length(computed.getPropertyValue('--nori-ai-height').trim(), 600, innerHeight - 32))
    const accent = computed.getPropertyValue('--nori-ai-accent').trim()
    this.#frame.style.setProperty('--accent', accent && CSS.supports('color', accent) ? accent : '#2563eb')
  }

  #length(value: string, fallback: number, maximum: number): string {
    let pixels = fallback
    // %와 전역 키워드는 길이가 아니며 var() 순환 등 계산 실패는 기본값으로 돌아간다.
    if (value && !/%|\b(auto|inherit|initial|unset|revert|none|fit-content|max-content|min-content)\b/i.test(value) && CSS.supports('width', value)) {
      const probe = document.createElement('div')
      probe.style.cssText = 'all:initial;position:fixed;visibility:hidden;pointer-events:none;font-size:16px'
      probe.style.width = value
      this.shadowRoot?.append(probe)
      const resolved = Number.parseFloat(getComputedStyle(probe).width)
      probe.remove()
      if (Number.isFinite(resolved) && resolved > 0) pixels = resolved
    }
    return `${Math.max(0, Math.min(pixels, maximum))}px`
  }
}

if (!customElements.get('nori-ai-widget')) {
  customElements.define('nori-ai-widget', NoriAiWidget)
}
