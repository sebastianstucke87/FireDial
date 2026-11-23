// A real Chrome or Edge with a throwaway profile, for the tests of the browsers made from Chromium.
// Branded Chrome no longer loads unpacked extensions from the command line, so Selenium fetches
// Chrome for Testing, which does, and the matching ChromeDriver. Edge still does: the installed
// one, with the matching EdgeDriver.

import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import chrome from 'selenium-webdriver/chrome.js'
import type chromium from 'selenium-webdriver/chromium.js'
import edge from 'selenium-webdriver/edge.js'
import * as z from 'zod/mini'

const WAIT = 50 // ms between looks at the page
const TIMEOUT = 5000 // ms

// The extension's id comes from its key, so a key of its own gives the tests a known id: the
// SHA-256 of the key, its first 32 hex digits written with a to p.
function keyed(dist: string): { dir: string; id: string } {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const id = createHash('sha256')
    .update(der)
    .digest('hex')
    .slice(0, 32)
    .replace(/./g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)))
  const dir = mkdtempSync(join(tmpdir(), 'firedial-chromium-'))
  cpSync(dist, dir, { recursive: true })
  const manifest = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, key: der.toString('base64') }))
  return { dir, id }
}

// The browser's bookmarks file with an empty FireDial folder in Other bookmarks: it keeps the
// defaults out, the way one brought by browser sync does.
function withFireDialFolder(profile: string): void {
  const folder = (id: string, name: string, children: unknown[] = []): unknown => ({ id, name, type: 'folder', children, date_added: '0', date_modified: '0' })
  mkdirSync(join(profile, 'Default'), { recursive: true })
  writeFileSync(
    join(profile, 'Default', 'Bookmarks'),
    JSON.stringify({
      version: 1,
      roots: {
        bookmark_bar: folder('1', 'Bookmarks bar'),
        other: folder('2', 'Other bookmarks', [folder('4', 'FireDial')]),
        synced: folder('3', 'Mobile bookmarks')
      }
    })
  )
}

export type Chromium = 'chrome' | 'edge'

interface Launch {
  options: () => chromium.Options
  start: (options: chromium.Options) => chromium.ChromiumWebDriver
}

// How each one is started: Chrome for Testing is fetched, Edge is the installed one.
const LAUNCH: Readonly<Record<Chromium, Launch>> = {
  chrome: {
    options: () => new chrome.Options(),
    start: (options) => {
      process.env['SE_FORCE_BROWSER_DOWNLOAD'] = 'true'
      return chrome.Driver.createSession(options)
    }
  },
  edge: { options: () => new edge.Options(), start: (options) => edge.Driver.createSession(options) }
}

export interface Session {
  driver: chromium.ChromiumWebDriver
  newtab: string
  downloads: string
  quit: () => Promise<void> // and deletes the profile
}

// hosts: where every address goes instead, e.g. a search engine's; the tests stay offline.
export async function startChromium(browser: Chromium, { defaults = false, hosts = '' } = {}): Promise<Session> {
  const { dir, id } = keyed(resolve(`dist/${browser}`))
  const profile = mkdtempSync(join(tmpdir(), 'firedial-profile-'))
  const downloads = join(profile, 'downloads')
  if (!defaults) withFireDialFolder(profile)
  const launch = LAUNCH[browser]
  const options = launch
    .options()
    .addArguments(
      '--headless=new',
      `--user-data-dir=${profile}`,
      `--load-extension=${dir}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run'
    )
  // Ubuntu doesn't let a browser outside the system's own sandbox itself.
  if (process.platform === 'linux') options.addArguments('--no-sandbox')
  if (hosts) options.addArguments(`--host-resolver-rules=MAP * ${hosts}, EXCLUDE 127.0.0.1`)
  options.setUserPreferences({ 'download.default_directory': downloads, 'download.prompt_for_download': false })
  const driver = launch.start(options)
  const quit = async (): Promise<void> => {
    await driver.quit()
    for (const folder of [dir, profile]) rmSync(folder, { recursive: true, force: true, maxRetries: 5 })
  }
  return { driver, newtab: `chrome-extension://${id}/newtab.html`, downloads, quit }
}

export async function until(driver: chromium.ChromiumWebDriver, what: string, check: () => Promise<boolean>, timeout = TIMEOUT): Promise<void> {
  const end = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > end) assert.fail(`Timed out waiting for: ${what}`)
    await driver.sleep(WAIT)
  }
}
