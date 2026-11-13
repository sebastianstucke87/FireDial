// A field of label chips, A to Z. While it has the focus, the known labels that match what's typed
// are listed below it, in the search's style; the focus stays in the field whatever is clicked in
// it, so the list stays open. Enter, Tab or a comma adds the one picked or what's typed, Backspace
// in an empty field takes the last chip off.

import { compareLabels, sameLabel, splitLabels } from '../model.ts'
import type { LabelName } from '../model.ts'
import { $$, closest, el, icon } from './dom.ts'

let pressing = false
document.addEventListener('pointerdown', () => {
  pressing = true
})
document.addEventListener('pointerup', () => {
  pressing = false
})

interface Options {
  known: () => readonly LabelName[]
  chip: (label: LabelName, remove: boolean) => HTMLElement
  label: string
  count?: (label: LabelName) => number // shown next to a suggestion, as in the sidebar
  onChange?: () => void
}

export class ChipField {
  values: LabelName[] = []
  readonly input: HTMLInputElement
  private readonly box: HTMLElement
  private readonly list = el('div', { class: 'Suggest ChipField__list', role: 'listbox', hidden: true })
  private readonly options: Options
  private index = 0

  constructor(root: HTMLElement, options: Options) {
    this.options = options
    this.input = el('input', {
      type: 'text',
      'aria-label': options.label,
      placeholder: 'Select labels', // the same everywhere
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 400
    })
    this.box = el('div', { class: 'Input ChipField__box' })
    root.classList.add('ChipField')
    root.append(this.box, this.list)
    // Clicks on the chips or the box keep the focus where it is: in the field.
    for (const area of [this.box, this.list])
      area.addEventListener('mousedown', (event) => {
        if (event.target === this.input) return
        event.preventDefault()
        this.input.focus()
      })
    this.box.addEventListener('click', (event) => {
      const remove = closest(event, '[data-remove]')?.dataset['remove']
      if (remove === undefined) return
      event.preventDefault()
      this.values = this.values.filter((label) => !sameLabel(label, remove))
      this.render()
      this.suggest()
    })
    this.list.addEventListener('click', (event) => {
      const item = closest(event, '.SuggestItem')
      if (item?.dataset['label'] !== undefined) this.add(item.dataset['label'])
    })
    this.input.addEventListener('keydown', (event) => {
      this.onKey(event)
    })
    this.input.addEventListener('input', () => {
      this.suggest()
    })
    this.input.addEventListener('focus', () => {
      this.suggest()
    })
    // A press elsewhere closes the list only once it's over: closed at once, it would move what's
    // below it, and the click would miss the button pressed (Remove, say).
    this.input.addEventListener('blur', () => {
      if (!pressing) {
        this.list.hidden = true
        return
      }
      document.addEventListener(
        'pointerup',
        () => {
          setTimeout(() => {
            if (document.activeElement !== this.input) this.list.hidden = true
          })
        },
        { once: true }
      )
    })
    this.list.addEventListener('mousemove', (event) => {
      const item = closest(event, '.SuggestItem')
      if (item) this.highlight(this.items().indexOf(item))
    })
    this.box.append(this.input) // no onChange yet: the page may still be setting up
  }

  set(values: readonly LabelName[]): void {
    this.values = [...values]
    this.input.value = ''
    this.list.hidden = true
    this.render()
  }

  // What's typed and not added yet joins the chips.
  commit(): void {
    if (this.input.value.trim()) this.add(this.input.value)
    this.list.hidden = true
  }

  // Known labels keep the way they're written.
  private add(text: string): void {
    const known = this.options.known()
    for (const typed of splitLabels(text)) {
      const label = known.find((each) => sameLabel(each, typed)) ?? typed
      if (!this.values.some((each) => sameLabel(each, label))) this.values.push(label)
    }
    this.input.value = ''
    this.render()
    this.suggest()
  }

  private render(): void {
    this.values.sort(compareLabels)
    // The field itself stays put: moved, it would lose the focus.
    for (const node of [...this.box.children]) if (node !== this.input) node.remove()
    this.input.before(...this.values.map((label) => this.options.chip(label, true)))
    this.options.onChange?.()
  }

  private items(): HTMLElement[] {
    return $$('.SuggestItem', HTMLElement, this.list)
  }

  private suggest(): void {
    const text = this.input.value.trim()
    const typed = text.toLocaleLowerCase()
    const known = this.options.known()
    const matches = known.filter((label) => !this.values.some((each) => sameLabel(each, label)) && label.toLocaleLowerCase().includes(typed))
    const fresh = text && !text.includes(',') && !known.some((label) => sameLabel(label, text))
    const item = (label: string, symbol: string, words: string, count?: number): HTMLElement =>
      el(
        'div',
        { class: 'SuggestItem', role: 'option', 'data-label': label },
        icon(symbol),
        el('span', {}, words),
        count !== undefined && el('small', {}, String(count)),
        el('kbd', {}, 'Enter')
      )
    this.list.replaceChildren(
      ...(fresh ? [item(text, 'plus', `New label: ${text}`)] : []),
      ...matches.map((label) => item(label, 'tag', label, this.options.count?.(label)))
    )
    const opening = this.list.hidden
    this.list.hidden = !this.list.childElementCount || document.activeElement !== this.input
    if (opening && !this.list.hidden) this.reveal()
    this.highlight(typed ? 0 : -1)
  }

  // The list just opened: the dialog scrolls so as much of it shows as fits, the field and its
  // section's heading still in sight.
  private reveal(): void {
    const scroller = this.box.closest('.Modal__body')
    if (!scroller) return
    const view = scroller.getBoundingClientRect()
    const [field, list] = [(this.box.closest('.Section') ?? this.box).getBoundingClientRect(), this.list.getBoundingClientRect()]
    const below = list.bottom - view.bottom
    if (below > 0) scroller.scrollTop += Math.min(below, field.top - view.top)
  }

  private highlight(index: number): void {
    const items = this.items()
    this.index = index < 0 ? -1 : (index + items.length) % Math.max(items.length, 1)
    items.forEach((item, at) => {
      item.classList.toggle('SuggestItem--active', at === this.index)
    })
  }

  private onKey(event: KeyboardEvent): void {
    const open = !this.list.hidden
    const picked = open ? this.items()[this.index]?.dataset['label'] : undefined
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open) return
      event.preventDefault()
      this.highlight(this.index + (event.key === 'ArrowDown' ? 1 : -1))
      this.items()[this.index]?.scrollIntoView({ block: 'nearest' }) // the dialog scrolls to it
    } else if (event.key === 'Enter' || event.key === ',' || (event.key === 'Tab' && (picked ?? this.input.value.trim()))) {
      if (!picked && !this.input.value.trim()) return // an empty Enter is the form's
      event.preventDefault()
      this.add(picked ?? this.input.value)
    } else if (event.key === 'Backspace' && !this.input.value && this.values.length) {
      this.values = this.values.slice(0, -1)
      this.render()
      this.suggest()
    } else if (event.key === 'Escape' && open) {
      event.preventDefault() // the list closes, not the dialog
      event.stopPropagation()
      this.list.hidden = true
    }
  }
}
