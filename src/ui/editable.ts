// A text field in place of something: Enter or leaving it saves, Esc cancels.

export function editable(input: HTMLInputElement, save: () => void, cancel: () => void): void {
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      input.blur()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancel() // before the blur: what's left in the field then has nothing to save
      input.blur()
    }
  })
  input.addEventListener('blur', () => {
    if (document.activeElement !== input) save() // still active: the window lost focus, not the field
  })
}
