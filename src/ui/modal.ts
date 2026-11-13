// Every dialog: flame and title on top, a close button as long as it can be dismissed. The page's
// markup holds only what's inside: a <dialog> with a <form>. [data-close] buttons close it. The head
// and the buttons (or a footer after a divider) stay in sight; what's between them scrolls.

import { $, closest, el, icon } from './dom.ts'

export class Modal {
  readonly dialog: HTMLDialogElement
  readonly form: HTMLFormElement
  private readonly titleText = el('span')
  private readonly closeButton = el('button', { type: 'button', class: 'IconButton Modal__close', 'data-close': true, 'aria-label': 'Close' }, icon('x'))
  private canDismiss = true

  constructor(dialog: HTMLDialogElement, title: string, dismissible = true) {
    this.dialog = dialog
    this.form = $('form', HTMLFormElement, dialog)
    const end = [...this.form.children].findIndex((child) => child.matches('.Modal__actions, .Divider'))
    const body = el('div', { class: 'Modal__body' }, ...[...this.form.children].slice(0, end < 0 ? undefined : end))
    this.form.prepend(el('header', { class: 'Modal__head' }, el('h2', { class: 'Modal__title' }, icon('flame'), this.titleText), this.closeButton), body)
    this.title = title
    this.dismissible = dismissible
    dialog.addEventListener('click', (event) => {
      if (closest(event, '[data-close]')) this.close()
    })
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation() // it's the modal's Esc, not the page's
      if (this.canDismiss) this.close()
    })
    dialog.addEventListener('cancel', (event) => {
      if (!this.canDismiss) event.preventDefault()
    })
  }

  set title(text: string) {
    this.titleText.textContent = text
    this.dialog.setAttribute('aria-label', text)
  }

  set dismissible(on: boolean) {
    this.canDismiss = on
    this.closeButton.hidden = !on
  }

  // Resolves 'save' when the form was submitted (Save button or Enter), else the close value ('' for Esc/Cancel).
  open(): Promise<string> {
    return new Promise((resolve) => {
      const { dialog, form } = this
      const done = (result: string): void => {
        form.removeEventListener('submit', onSubmit)
        dialog.removeEventListener('close', onClose)
        // A field of a closed dialog keeps no focus, so the page's keys work again.
        const focused = document.activeElement
        if (focused instanceof HTMLElement && dialog.contains(focused)) focused.blur()
        resolve(result)
      }
      // Resolve on submit itself: the close event can lag behind (e.g. in a background tab).
      const onSubmit = (): void => {
        done('save')
      }
      const onClose = (): void => {
        done(dialog.returnValue)
      }
      form.addEventListener('submit', onSubmit)
      dialog.addEventListener('close', onClose)
      dialog.returnValue = ''
      dialog.showModal()
    })
  }

  close(): void {
    this.dialog.close()
  }
}
