# FireDial privacy policy

FireDial collects no data. It has no servers, no accounts, no analytics and no ads. Nothing is sold, shared or sent to anyone. Everything FireDial handles stays on your device, except bookmarks your browser syncs, if sync is on, and what you sync to your own Google Drive, if you turn on Sync.

## What FireDial handles

| Data                                       | Why                                    | Where it stays                                        |
| ------------------------------------------ | -------------------------------------- | ----------------------------------------------------- |
| Bookmarks in the FireDial folder           | They are your sparks                   | The browser's bookmarks; your browser's sync, if on   |
| Website content: previews of pages you add | The spark's preview                    | Extension storage on your device                      |
| Website content: site icons                | The spark's icon                       | Extension storage on your device                      |
| Settings and undo history                  | Layout, colors, views, undoing changes | Extension storage on your device                      |
| Backups                                    | Saving your sparks to a file           | A file in your downloads folder, when you ask for one |
| Sparks, views, settings and previews       | Sync between your browsers             | Your Google Drive, only if you turn on Sync           |
| Your Google account's email address        | Shows which account Sync uses          | Extension storage on your device                      |

FireDial handles no other data.

## Network connections

- **Search:** text typed into the search box goes to your browser's default search engine, through the browser, as any search from the address bar would.
- **Bookmark import:** only if you allow access to all sites, FireDial loads each imported site's own page to find its icon. No other service is contacted. FireDial keeps that access until you close the browser.
- **Refresh preview:** only when you choose it and allow access to all sites, FireDial opens the page in a tab, takes a new preview and closes the tab. If the page can't be captured, it loads the site's icon instead. FireDial keeps that access until you close the browser.
- **Image from a web page:** only when you click "Load image" and allow access to that site, FireDial loads that image once and keeps it on your device. FireDial keeps that access until you close the browser.

- **Sync:** only if you click "Sync with Google Drive" and sign in to Google. FireDial then keeps your sparks, views, settings and previews in a hidden FireDial folder in your own Google Drive (Google's app data folder), and reads them from there in your other browsers. It can't see any other file in your Drive. The data goes from your browser to Google and back; it never passes through anyone else. Google's privacy policy applies to what's stored there.

FireDial makes no other connections.

## Third-party code

FireDial contains no third-party tracking or data collection. The libraries it bundles are the `dependencies` in [package.json](https://github.com/sebastianstucke87/FireDial/blob/main/package.json); none of them collects data.

## Removing your data

Uninstalling FireDial deletes its extension storage. Your browser bookmarks and downloaded backup files stay until you delete them from your device.

If you used Sync, "Delete from Drive" in FireDial's settings deletes everything FireDial put in your Google Drive and removes FireDial's access to it. You can also remove it in Google Drive under Settings → Manage apps → FireDial → Delete hidden app data.

## Official sources

FireDial is published at:

- GitHub: [github.com/sebastianstucke87/FireDial](https://github.com/sebastianstucke87/FireDial)
- Google, Chrome Web Store: [chromewebstore.google.com/detail/khflkpkeicdbceieebokdclnedonmphk](https://chromewebstore.google.com/detail/khflkpkeicdbceieebokdclnedonmphk)
- Mozilla, Firefox Add-ons: [addons.mozilla.org/firefox/addon/firedial](https://addons.mozilla.org/firefox/addon/firedial)

Anything else claiming to be FireDial is fake; report it to the organization that hosts it.

## Contact

Contact: [Open an issue](https://github.com/sebastianstucke87/FireDial/issues) or [report a vulnerability](https://github.com/sebastianstucke87/FireDial/security/advisories/new).

## Changes

Changes to this policy are made in this file; its history is on GitHub.
