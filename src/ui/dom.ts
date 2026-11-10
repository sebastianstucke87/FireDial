// The small DOM helpers everything on the page builds on.

type Constructor<T> = abstract new () => T

export function $<T extends Element>(selector: string, type: Constructor<T>, root: ParentNode = document): T {
  const node = root.querySelector(selector)
  if (!(node instanceof type)) throw new Error(`Missing ${selector}`)
  return node
}

export function $$<T extends Element>(selector: string, type: Constructor<T>, root: ParentNode = document): T[] {
  const nodes: T[] = []
  for (const node of root.querySelectorAll(selector)) {
    if (node instanceof type) nodes.push(node)
  }
  return nodes
}

export const html = (selector: string, root?: ParentNode): HTMLElement => $(selector, HTMLElement, root)
export const targetOf = (event: Event): Element | null => (event.target instanceof Element ? event.target : null)

export function closest(event: Event, selector: string): HTMLElement | null {
  const node = targetOf(event)?.closest(selector)
  return node instanceof HTMLElement ? node : null
}

type Attributes = Record<string, string | number | boolean | undefined>
type Child = Node | string | null | false | undefined

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Attributes = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) node.setAttribute(key, String(value))
  }
  node.append(...children.filter((child) => child != null && child !== false))
  return node
}

// Icons are symbols in newtab.html (#i-<name>).
export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  svg.setAttribute('class', 'icon')
  use.setAttribute('href', `#i-${name}`)
  svg.append(use)
  return svg
}
