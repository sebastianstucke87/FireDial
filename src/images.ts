// Previews and icons are kept as data URLs only. A web address would be loaded from its site
// every time a new tab shows it: slow, gone offline, and a connection nobody asked for.

// Only images: a data URL of another type (text/html, say, from a file or a synced Drive) is no preview.
export const isStoredImage = (src: string): boolean => /^data:image\/[a-z0-9.+-]+[;,]/i.test(src)

// Workers have no FileReader everywhere, so by hand. In chunks: spreading a whole image overflows the stack.
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`
}

// Chrome's own copy of a page's icon (the favicon permission), from its cache: no request to the site.
export const faviconPath = (pageUrl: string, size: number): string => `/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`

// Access to just these sites, asked for when the user wants something from them and given back after.
export const siteAccess = (origins: readonly string[]): { origins: string[] } => ({ origins: origins.map((origin) => `${origin}/*`) })
