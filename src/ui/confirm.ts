// A question that can't be answered by accident: its button waits for the checkbox.

import { el, icon } from './dom.ts'
import { Modal } from './modal.ts'

export interface Question {
  title: string
  text: string
  button: string
}

export class Confirm {
  private readonly check = el('input', { type: 'checkbox', autofocus: true })
  private readonly text = el('span')
  private readonly label = el('span')
  private readonly button = el('button', { class: 'Button Button--primary' }, icon('alert'), this.label)
  private readonly modal: Modal

  constructor() {
    const actions = el(
      'div',
      { class: 'Modal__actions' },
      el('button', { type: 'button', class: 'Button', 'data-close': true }, 'Cancel'),
      el('span', { class: 'Spacer' }),
      this.button
    )
    const dialog = el('dialog', { class: 'Modal' }, el('form', { method: 'dialog' }, el('label', { class: 'Confirm' }, this.check, this.text), actions))
    document.body.append(dialog)
    this.modal = new Modal(dialog, '')
    this.check.addEventListener('change', () => {
      this.button.disabled = !this.check.checked
    })
  }

  async ask({ title, text, button }: Question): Promise<boolean> {
    this.modal.title = title
    this.text.textContent = text
    this.label.textContent = button
    this.check.checked = false
    this.button.disabled = true
    return (await this.modal.open()) === 'save'
  }
}
