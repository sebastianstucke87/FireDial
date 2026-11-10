// A real Firefox with a throwaway profile, for the tests here. Selenium fetches geckodriver if it's missing.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import firefox from 'selenium-webdriver/firefox.js'
import * as z from 'zod/mini'

const Manifest = z.object({ browser_specific_settings: z.object({ gecko: z.object({ id: z.string() }) }) })

const EXTENSION_ID = Manifest.parse(JSON.parse(readFileSync('browsers/firefox/manifest.json', 'utf8'))).browser_specific_settings.gecko.id
const UUID = '11111111-2222-4333-8444-555555555555'
const WAIT = 50 // ms between looks at the page
const TIMEOUT = 5000 // ms

export const NEWTAB = `moz-extension://${UUID}/newtab.html`

export function startFirefox(prefs: Record<string, string | number | boolean> = {}): firefox.Driver {
  const options = new firefox.Options().addArguments('-headless').setPreference('extensions.webextensions.uuids', JSON.stringify({ [EXTENSION_ID]: UUID }))
  for (const [name, value] of Object.entries(prefs)) options.setPreference(name, value)
  const service = new firefox.ServiceBuilder().addArguments('--allow-system-access')
  return firefox.Driver.createSession(options, service.build())
}

// Empty, as the tests expect: a FireDial bookmark folder made first keeps the defaults out, the
// way one brought by Firefox Sync does. defaults: true installs FireDial as a fresh install gets it.
export async function installFireDial(driver: firefox.Driver, { defaults = false } = {}): Promise<string> {
  if (!defaults) {
    await driver.setContext(firefox.Context.CHROME)
    await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1]
      const { PlacesUtils } = ChromeUtils.importESModule('resource://gre/modules/PlacesUtils.sys.mjs')
      PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.unfiledGuid, type: PlacesUtils.bookmarks.TYPE_FOLDER, title: 'FireDial' }).then(() => done())`)
    await driver.setContext(firefox.Context.CONTENT)
  }
  return driver.installAddon('dist/firefox', true)
}

export async function until(driver: firefox.Driver, what: string, check: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + TIMEOUT
  while (!(await check())) {
    if (Date.now() > end) assert.fail(`Timed out waiting for: ${what}`)
    await driver.sleep(WAIT)
  }
}
