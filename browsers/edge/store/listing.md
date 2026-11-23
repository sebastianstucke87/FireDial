# Edge Add-ons listing

What to fill in on Edge Add-ons (Partner Center → Microsoft Edge → FireDial). The first version was uploaded by hand; since then each release uploads `dist/edge` and submits it for review (`release.yml`, once `EDGE_ADD_ONS_UPLOAD` is `true`). Everything here is set by hand.

## Availability

Public, all markets.

## Properties

- Category: Productivity
- Website: https://firedial.org/
- Support contact: https://github.com/sebastianstucke87/FireDial/issues
- Mature content: no

## Privacy

### Single purpose

```
Shows the user's bookmarks as a speed dial on the new tab page.
```

### Permission justification

The same as on the Chrome Web Store: `browsers/chrome/store/listing.md`, with Edge for Chrome.

### Remote code

No, I am not using remote code.

### Data usage

Nothing collected by the developer. Sync is optional: it sends the user's sparks, settings and previews to their own Google Drive app folder (scope `drive.appdata`) and the backups to a FireDial folder in their Drive (scope `drive.file`), nowhere else. Tick "Website content" (previews) and the certifications.

### Privacy policy URL

https://firedial.org/privacy.html

## Store listing (English)

### Description

At least 250 characters.

```
FireDial turns your new tab into a speed dial of your bookmarks, in views. Add any page with a right-click.

Pick a layout, columns, light or dark and an accent color. Search, undo, backups.

Optional Sync keeps FireDial the same in Firefox, Chrome and Edge, through your own Google Drive.

No ads, no account, no tracking. Your sparks are Edge bookmarks, so Edge sync carries them. Open source: https://github.com/sebastianstucke87/FireDial

Enjoy your new tab!
```

The name and the short description come from `browsers/edge/manifest.json`.

### Extension logo

`store/logo.png` (300×300, made with `node scripts/icon.local.ts`).

### Small promotional tile

`browsers/shared/promo-small.png` (440×280). No large tile.

### Screenshots

`browsers/shared/screenshots/` scaled to 1280×800, with the captions in `browsers/firefox/store/listing.md`: the same everywhere.

### Search terms

speed dial, new tab, bookmarks, start page, dashboard, tiles, sync

## Notes for certification

```
FireDial replaces the new tab page. Open a new tab to see it; Edit (top right) holds the settings. Sync with Google Drive is optional and not needed to test anything else.
```
