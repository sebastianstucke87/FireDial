<img height="150" src="browsers/publishing/amo-icon.png"/>

# FireDial

Minimal speed dial for your bookmarks in Firefox! Completely free and open source: no ads, no account, no tracking, no BS.

<img src="browsers/screenshots/light.png" alt="FireDial in light, wide layout"/>

<p>
  <img width="32%" src="browsers/screenshots/dark.png" alt="FireDial in dark, Violet, tiles"/>
  <img width="32%" src="browsers/screenshots/edit.png" alt="FireDial in Edit, dark, Teal"/>
  <img width="32%" src="browsers/screenshots/list.png" alt="FireDial in light, light blue, list, with colorful labels"/>
</p>

## Install

From addons.mozilla.org: https://addons.mozilla.org/firefox/addon/firedial/

## Usage

- Right-click a page, link or tab: **Add to FireDial**.
- **Edit**: settings. **About**: shortcuts, bookmark import.
- Views filter sparks by label, e.g. _Work or News_, _all but Private_.
- Sparks are bookmarks (**Other Bookmarks → FireDial**), so Firefox Sync carries them. Images stay local.

## Build

```bash
git clone https://github.com/sebastianstucke87/FireDial.git
cd FireDial
npm ci
npm run build
```

The add-on is in `dist/firefox`. `npm test` runs the checks and the tests in headless Firefox.

To load your build until Firefox restarts:

1. Open `about:debugging#/runtime/this-firefox`
2. Click `Load Temporary Add-on...`
3. Pick `dist/firefox/manifest.json`

## Trust

- FireDial is only published at `github.com/sebastianstucke87/FireDial` and `addons.mozilla.org/firefox/addon/firedial`. Anything else claiming to be FireDial is fake; report it.
- FireDial is not for sale.
- Something odd? [Open an issue](https://github.com/sebastianstucke87/FireDial/issues) or [report a vulnerability](https://github.com/sebastianstucke87/FireDial/security/advisories/new).
