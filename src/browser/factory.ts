// Picks the browser FireDial runs in: the only place that looks at which one it is.
//
// Chrome has chrome.* where Firefox has browser.* (newer Chrome has browser.* too). With Manifest
// V3 both return promises, so on Chrome browser is chrome, with the menus Chrome calls
// contextMenus. The rest of FireDial uses browser.* only.

import * as z from 'zod/mini'

import { chromeFor } from './chrome.ts'
import { firefox } from './firefox.ts'
import type { Browser } from './shared.ts'

interface Api {
  runtime: { getURL(path: string): string }
}

interface Scope<T extends Api> {
  browser?: T | undefined
  chrome?: T | undefined
}

// Whether the scope is Chrome's, told by the address of FireDial's own pages; gives it the
// browser.* FireDial expects if so.
export function adapt<T extends Api>(scope: Scope<T>): boolean {
  const api = scope.browser ?? scope.chrome
  if (!api?.runtime.getURL('').startsWith('chrome-extension:')) return false
  const adapted = new Proxy(api, {
    get: (target, key) => Reflect.get(target, key === 'menus' ? 'contextMenus' : key)
  })
  Object.defineProperty(scope, 'browser', { value: adapted, configurable: true, writable: true })
  return true
}

// Chrome's navigator.userAgentData, which TypeScript doesn't know yet.
const UserAgentData = z.catch(z.object({ brands: z.array(z.object({ brand: z.string() })) }), { brands: [] })

// "Chrome", "Edge", "Brave": the browser made from Chromium, as its brands name it.
export function productOf(userAgentData: unknown): string {
  const { brands } = UserAgentData.parse(userAgentData)
  const brand = brands.map((each) => each.brand).find((name) => !/chromium|not.?a.?brand/i.test(name))
  return (brand ?? 'Chrome').replace(/^(Google|Microsoft) /, '')
}

// Node, where the tests run, counts as Firefox.
export function browserFor<T extends Api>(scope: Scope<T>, userAgentData: unknown): Browser {
  return adapt(scope) ? chromeFor(productOf(userAgentData)) : firefox
}
