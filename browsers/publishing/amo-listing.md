# AMO listing

What to fill in on addons.mozilla.org (Developer Hub → Edit Product Page). Name, summary, categories, license and reviewer notes come from `amo-metadata.json` with each release; everything else is set here by hand.

## Name

FireDial

## Custom URL

`firedial`: https://addons.mozilla.org/firefox/addon/firedial/

## Icon

`amo-icon.png` (512px), made with `node scripts/icon.local.ts`.

## Experimental

No.

## Summary

Same as `description` in `browsers/firefox/manifest.json`.

## Description

```
FireDial turns your new tab into a speed dial of your bookmarks. It starts with groups of good causes, journalism and open web projects: keep them, or delete them in Edit. About → Start over brings them back.

• Add any page, link or tab with a right-click: Add to FireDial
• Sort sparks into groups, drag them into order
• Tiles or list, wide or square, columns and spacing as you like
• Search your sparks, or the web with your Firefox search engine
• Undo and redo for every change
• Light, dark or system theme, with an accent color of your choice
• Keyboard shortcuts for everything (see About)
• Export and import backups; before an import replaces anything, FireDial saves one automatically

Your sparks are plain bookmarks in Other Bookmarks → FireDial, so Firefox Sync carries them to your other devices. Preview images stay on this device.

Completely free and open source (MIT): no ads, no account, no tracking, no BS.
```

## Categories

Tabs, Bookmarks

## Tags

search, privacy (AMO's fixed list has nothing closer; categories carry Tabs and Bookmarks)

## Homepage

https://github.com/sebastianstucke87/FireDial

## Support site

https://github.com/sebastianstucke87/FireDial/issues

## Support email

None.

## License

MIT

## Privacy policy

None needed: FireDial collects and sends no data (`data_collection_permissions: none`).

## Screenshots

Made with `npm run build && node scripts/shots.local.ts` (add `dark` for the dark theme) into `shots.local/`, from `demo.local.json`.

| File          | Caption                                    |
| ------------- | ------------------------------------------ |
| `1-home.png`  | Your bookmarks as a speed dial, in groups  |
| `2-edit.png`  | Edit: layout, columns, spacing and backups |
| `3-about.png` | Keyboard shortcuts for everything          |

## Permissions, if a reviewer asks

| Permission         | Used for                                                |
| ------------------ | ------------------------------------------------------- |
| `bookmarks`        | Sparks are stored as bookmarks                          |
| `menus`            | The Add to FireDial context menu                        |
| `activeTab`        | A preview image of the page being added                 |
| `scripting`        | The short confirmation shown on that page after adding  |
| `search`           | Searching the web with the user's Firefox search engine |
| `downloads`        | Saving backups                                          |
| `storage`          | Settings, undo history, preview images                  |
| `unlimitedStorage` | Preview images can outgrow the default quota            |
