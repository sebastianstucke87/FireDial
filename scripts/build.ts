// Builds the extension into dist/firefox.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const out = 'dist/firefox'

rmSync('dist', { recursive: true, force: true })

await build({
  entryPoints: ['src/background.ts', 'src/newtab.ts', 'src/theme.ts'],
  outdir: `${out}/js`,
  bundle: true,
  format: 'esm',
  target: 'firefox142'
})

// The version is the build's UTC time: YYYY.M.D.HHMMSS, e.g. 2026.11.10.183412 (18:34:12).
// Firefox only takes up to four dot-separated numbers without leading zeros, so 09:05:00 is 90500.
// A release passes its tag's version in FIREDIAL_VERSION, so the tag and the build agree.
function calver(now: Date): string {
  const time = now.getUTCHours() * 10_000 + now.getUTCMinutes() * 100 + now.getUTCSeconds()
  return [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate(), time].join('.')
}

const version = process.env['FIREDIAL_VERSION'] || calver(new Date())
if (!/^(0|[1-9]\d{0,8})(\.(0|[1-9]\d{0,8})){0,3}$/.test(version)) throw new Error(`Not a Firefox version: ${version}`)
const manifest: unknown = JSON.parse(readFileSync('browsers/firefox/manifest.json', 'utf8'))
if (typeof manifest !== 'object' || manifest === null) throw new Error('browsers/firefox/manifest.json is not an object')
mkdirSync(out, { recursive: true })
writeFileSync(
  `${out}/manifest.json`,
  `${JSON.stringify({ ...manifest, version }, null, 4)}
`
)
console.log(`FireDial ${version}`)
cpSync('browsers/icons', `${out}/icons`, { recursive: true })
cpSync('src/newtab.html', `${out}/newtab.html`)
cpSync('src/newtab.css', `${out}/newtab.css`)
cpSync('src/defaults.json', `${out}/defaults.json`)
cpSync('src/fonts', `${out}/fonts`, { recursive: true })
// FireDial's license, then those of what it bundles: zod in js/, the Onest font in fonts/.
const license = (title: string, file: string): string => `${title}\n\n${readFileSync(file, 'utf8').trimEnd()}\n`
writeFileSync(
  `${out}/LICENSES.txt`,
  [license('FireDial', 'LICENSE'), license('zod', 'node_modules/zod/LICENSE'), license('Onest font', 'src/fonts/OFL.txt')].join('\n\n')
)
