// FireDial's words, kept: a browser (firefox, chrome, edge) names what runs, a store (Firefox
// Add-ons, Chrome Web Store, Edge Add-ons) where it's published. No store abbreviations, and which
// browser FireDial is in is looked at in one place only: src/browser/factory.ts.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SELF = 'src/language.test.ts'

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file && file !== SELF && !/\.(png|jpe?g|ico|woff2?)$/i.test(file))

// Each line of each file, without embedded images (their base64 spells anything) and without
// web-ext's own --amo-metadata flag.
function* lines(): Generator<[string, number, string]> {
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue // deleted, not yet staged
    }
    for (const [index, line] of text.split('\n').entries()) {
      yield [file, index + 1, line.replace(/data:[\w/+.-]+;base64,[\w+/=]+/g, '').replace(/--amo-metadata\b/g, '')]
    }
  }
}

const found = (rule: RegExp, allowed: (file: string) => boolean = () => false): string[] =>
  [...lines()].filter(([file, , line]) => rule.test(line) && !allowed(file)).map(([file, number, line]) => `${file}:${number}: ${line.trim()}`)

test('stores by their full names, no abbreviations', () => {
  assert.deepEqual(found(/\b(amo|cws|awo)\b|IS_CHROME|BROWSER_NAME/i), [])
})

test('which browser FireDial is in, looked at only where it is picked', () => {
  // The e2e launchers start a browser and know which; the browser tests fake each one.
  const picks = (file: string): boolean => file.startsWith('src/browser/') || file.startsWith('e2e/')
  assert.deepEqual(found(/moz-extension:|chrome-extension:|typeof chrome\b|userAgentData/, picks), [])
})
