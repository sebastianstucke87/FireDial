// The strip at the end of a text field that empties it. The field's box is the element around it
// (.Input), so the strip fills that box's end.

import { el, icon } from './dom.ts'

// Returns a call for when the value was set by code rather than typed.
export function clearable(input: HTMLInputElement): () => void {
  const button = el('button', { type: 'button', class: 'Strip Clear', 'aria-label': 'Clear', tabindex: -1 }, icon('x'))
  const refresh = (): void => {
    button.hidden = !input.value
  }
  button.addEventListener('click', (event) => {
    event.preventDefault() // the button sits inside a label
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true })) // as if typed away, so the field's listeners follow
    input.focus()
  })
  input.addEventListener('input', refresh)
  input.after(button)
  refresh()
  return refresh
}
