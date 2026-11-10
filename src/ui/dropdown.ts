// A select whose open list is one shape with its button: <select> can't do that. The list is fixed
// to the window, so a dialog doesn't cut it off, and opens upward when only there is room.

import { $$, closest, el, icon, targetOf } from './dom.ts'

const EDGE = 16 // px kept free at the window's edge
const MAX_HEIGHT = 0.6 // of the window

export interface Choice<T> {
  value: T
  label: string
}

export class Dropdown<T> {
  private readonly root: HTMLElement
  private readonly button: HTMLButtonElement
  private readonly list = el('div', { class: 'Dropdown__list', role: 'listbox', hidden: true })
  private readonly text = el('span')
  private readonly onPick: (value: T) => void
  private choices: readonly Choice<T>[] = []
  private current: T | null = null

  constructor(root: HTMLElement, label: string, onPick: (value: T) => void = () => undefined) {
    this.root = root
    this.onPick = onPick
    this.button = el(
      'button',
      { type: 'button', class: 'Dropdown__button', 'aria-haspopup': 'listbox', 'aria-expanded': false, 'aria-label': label },
      this.text,
      icon('chevron')
    )
    root.classList.add('Dropdown')
    root.append(this.button, this.list)
    this.button.addEventListener('click', () => {
      this.setOpen(!this.isOpen)
    })
    this.list.addEventListener('click', (event) => {
      const option = closest(event, '.Dropdown__option')
      const choice = this.choices[Number(option?.dataset['index'])]
      if (choice) this.pick(choice.value)
    })
    root.addEventListener('keydown', (event) => {
      this.onKey(event)
    })
    document.addEventListener('mousedown', (event) => {
      const target = targetOf(event)
      if (!target || !root.contains(target)) this.close()
    })
    document.addEventListener(
      'scroll',
      (event) => {
        if (event.target !== this.list) this.close()
      },
      true
    )
    window.addEventListener('resize', () => {
      this.close()
    })
  }

  get value(): T | null {
    return this.current
  }

  setChoices(choices: readonly Choice<T>[], value: T): void {
    this.choices = choices
    this.current = value
    this.text.textContent = choices.find((choice) => choice.value === value)?.label ?? ''
    this.list.replaceChildren(
      ...choices.map((choice, index) =>
        el('button', { type: 'button', class: 'Dropdown__option', role: 'option', 'aria-selected': choice.value === value, 'data-index': index }, choice.label)
      )
    )
  }

  close(): void {
    this.setOpen(false)
  }

  private get isOpen(): boolean {
    return this.root.classList.contains('Dropdown--open')
  }

  private pick(value: T): void {
    this.setChoices(this.choices, value)
    this.close()
    this.button.focus()
    this.onPick(value)
  }

  private setOpen(open: boolean): void {
    this.root.classList.toggle('Dropdown--open', open)
    this.list.hidden = !open
    this.button.setAttribute('aria-expanded', String(open))
    if (!open) return
    this.place()
    const options = this.options()
    ;(options.find((option) => option.getAttribute('aria-selected') === 'true') ?? options[0])?.focus()
  }

  private place(): void {
    const box = this.button.getBoundingClientRect()
    const below = innerHeight - box.bottom - EDGE
    const above = box.top - EDGE
    const up = this.list.scrollHeight > below && above > below
    this.root.classList.toggle('Dropdown--up', up)
    Object.assign(this.list.style, {
      left: `${box.left}px`,
      width: `${box.width}px`,
      top: up ? 'auto' : `${box.bottom - 2}px`,
      bottom: up ? `${innerHeight - box.top - 2}px` : 'auto',
      maxHeight: `${Math.min(innerHeight * MAX_HEIGHT, up ? above : below)}px`
    })
  }

  private options(): HTMLElement[] {
    return $$('.Dropdown__option', HTMLElement, this.list)
  }

  private onKey(event: KeyboardEvent): void {
    const arrow = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (!this.isOpen) {
      if (!arrow) return
      this.setOpen(true)
    } else if (event.key === 'Tab') {
      this.close()
      return
    } else if (event.key === 'Escape') {
      this.close()
      this.button.focus()
    } else if (arrow) {
      const options = this.options()
      const index = options.findIndex((option) => option === document.activeElement)
      options[(index + arrow + options.length) % options.length]?.focus()
    } else {
      return
    }
    event.stopPropagation()
    event.preventDefault()
  }
}
