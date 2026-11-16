# Chrome Web Store listing

What to fill in on the Chrome Web Store (Developer Dashboard → FireDial). Each release uploads `dist/chrome` and submits it for review (`release.yml`); everything here is set by hand.

## Store listing

### Description

```
FireDial turns your new tab into a speed dial of your bookmarks, in views. Add any page with a right-click.

Pick a layout, columns, light or dark and an accent color. Search, undo, backups.

Optional Sync keeps FireDial the same in Firefox and Chrome, through your own Google Drive.

No ads, no account, no tracking. Your sparks are Chrome bookmarks, so Chrome sync carries them. Open source: https://github.com/sebastianstucke87/FireDial

Enjoy your new tab!
```

The summary is `description` in `browsers/chrome/manifest.json`.

### Category

Productivity → Tools

### Language

English

### Store icon

`cws-icon.png` (orange; the icons inside Chrome are grey)

### Screenshots

`browsers/screenshots/` scaled to 1280×800, the only size the store takes, with the captions in `amo-listing.md`: the same everywhere.

### Small promo tile

`cws-promo-small.png` (440×280), made with the screenshots. No marquee tile.

### Homepage URL

https://firedial-app.github.io/

### Support URL

https://github.com/sebastianstucke87/FireDial/issues

## Privacy

### Single purpose

```
Shows the user's bookmarks as a speed dial on the new tab page.
```

### Permission justification

| Permission              | Justification                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bookmarks`             | Sparks are stored as bookmarks                                                                                                                                  |
| `contextMenus`          | The Add to FireDial context menu                                                                                                                                |
| `activeTab`             | A preview image of the page being added                                                                                                                         |
| `scripting`             | The short confirmation shown on that page after adding                                                                                                          |
| `search`                | Searching the web from the new tab with the user's default search engine                                                                                        |
| `downloads`             | Saving backups                                                                                                                                                  |
| `identity`              | Signing in to Google for the optional Sync, which keeps the user's sparks in their own Google Drive app folder                                                  |
| `favicon`               | A page's icon from Chrome's own copy when no preview can be taken, so the site isn't asked                                                                      |
| `storage`               | Settings, undo history, preview images                                                                                                                          |
| `unlimitedStorage`      | Preview images can outgrow the default quota                                                                                                                    |
| `<all_urls>` (optional) | Asked for only when the user imports bookmarks, refreshes a preview (to capture the page) or loads an image from a web page; given back when the browser closes |

### Remote code

No, I am not using remote code.

### Data usage

Nothing collected by the developer. Sync is optional: it sends the user's sparks, settings and previews to their own Google Drive app folder (scope `drive.appdata`) and the backups to a FireDial folder in their Drive (scope `drive.file`), nowhere else. Tick "Website content" (previews) and the three certifications.

### Privacy policy URL

https://firedial-app.github.io/privacy.html

## Distribution

Public, all regions.
