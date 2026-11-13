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
FireDial turns your new tab into a speed dial of your bookmarks, in views. Add any page with a right-click.

Pick a layout, columns, light or dark and an accent color. Search, undo, backups.

No ads, no account, no tracking. Your sparks are Firefox bookmarks, so Sync carries them. Open source: https://github.com/sebastianstucke87/FireDial

Enjoy your new tab!
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

Made with `npm run build && node scripts/shots.local.ts` (add `dark` for the dark theme) into `shots.local/`, from the sparks FireDial comes with.

| File          | Caption                                    |
| ------------- | ------------------------------------------ |
| `1-home.png`  | Your bookmarks as a speed dial, in views   |
| `2-edit.png`  | Edit: layout, columns, spacing and backups |
| `3-about.png` | Keyboard shortcuts for everything          |
| `4-views.png` | Views pick sparks by their labels          |

## Permissions, if a reviewer asks

| Permission              | Used for                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `bookmarks`             | Sparks are stored as bookmarks                                                                              |
| `menus`                 | The Add to FireDial context menu                                                                            |
| `activeTab`             | A preview image of the page being added                                                                     |
| `scripting`             | The short confirmation shown on that page after adding                                                      |
| `search`                | Searching the web with the user's Firefox search engine                                                     |
| `downloads`             | Saving backups                                                                                              |
| `storage`               | Settings, undo history, preview images                                                                      |
| `unlimitedStorage`      | Preview images can outgrow the default quota                                                                |
| `<all_urls>` (optional) | Asked for only by the bookmark import, to load each site's icon from the site itself; given back afterwards |
