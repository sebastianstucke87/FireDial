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
FireDial turns your new tab into a speed dial of your bookmarks, sorted into groups. It starts with good causes, journalism and open web projects: keep them, delete them, or add your own with a right-click on any page, link or tab.

Choose wide, tiles, square or list, the number of columns, light or dark and an accent color. Search your sparks or the web, undo any change, and save backups.

FireDial shows no ads, needs no account and sends your data nowhere. Your sparks are plain Firefox bookmarks, so Firefox Sync carries them to your other devices. Completely free and open source: https://github.com/sebastianstucke87/FireDial

Changed your mind about the starting sparks? About → Start over brings them back. Enjoy your new tab!
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
