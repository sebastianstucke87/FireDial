// A question that can't be answered by accident: its button waits for the checkbox. A plain
// question, for what's easy to take back, has no checkbox.

import { el, icon } from './dom.ts'
import { Modal } from './modal.ts'

export interface Question {
  title: string
  text: string
  button: string
  plain?: boolean
}

export class Confirm {
  private readonly check = el('input', { type: 'checkbox' })
  private readonly text = el('span')
  private readonly plainText = el('p', { class: 'Modal__text' })
  private readonly label = el('span')
  private readonly warn = icon('alert')
  private readonly box = el('label', { class: 'Confirm' }, this.check, this.text)
  private readonly button = el('button', { class: 'Button Button--primary' }, this.warn, this.label)
  private readonly modal: Modal

  constructor() {
    const actions = el(
      'div',
      { class: 'Modal__actions' },
      el('button', { type: 'button', class: 'Button', 'data-close': true }, 'Cancel'),
      el('span', { class: 'Spacer' }),
      this.button
    )
    const dialog = el('dialog', { class: 'Modal' }, el('form', { method: 'dialog' }, this.box, this.plainText, actions))
    document.body.append(dialog)
    this.modal = new Modal(dialog, '')
    this.check.addEventListener('change', () => {
      this.button.disabled = !this.check.checked
    })
    this.button.addEventListener('click', () => {
      this.onYes?.()
    })
  }

  private onYes: (() => void) | null = null

  // yes runs in the click on the button itself, for what Firefox allows only there.
  async ask({ title, text, button, plain = false }: Question, yes?: () => void): Promise<boolean> {
    this.onYes = yes ?? null
    this.modal.title = title
    this.text.textContent = text
    this.plainText.textContent = text
    this.box.hidden = plain
    this.plainText.hidden = !plain
    this.warn.style.display = plain ? 'none' : ''
    this.label.textContent = button
    this.check.checked = false
    this.button.disabled = !plain
    ;(plain ? this.button : this.check).autofocus = true
    ;(plain ? this.check : this.button).autofocus = false
    return (await this.modal.open()) === 'save'
  }
}
