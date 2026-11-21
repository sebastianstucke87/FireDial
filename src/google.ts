// Google sign-in for sync: a token for Drive's app folder only, through the browser's own sign-in
// window. Interactive only from a click; when the token runs out, a silent renewal is tried first.

import * as z from 'zod/mini'

import { IS_CHROME } from './browser.ts'
import type { Auth } from './drive.ts'
import { OfflineError, SignInError } from './drive.ts'
import { GOOGLE_CLIENT_ID } from './sync-config.ts'

// What sync sends to Drive, in Firefox's words: sparks are bookmarks, previews show web pages.
export const SYNC_DATA: browser._manifest.OptionalDataCollectionPermission[] = ['bookmarksInfo', 'websiteContent']

// Sync's hidden app folder, and the files FireDial makes in the user's Drive: the backups.
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file'
const TOKEN = 'syncToken' // in storage.session: gone when the browser closes

function authUrl(interactive: boolean, hint: string, state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: 'token',
    redirect_uri: browser.identity.getRedirectURL(),
    scope: SCOPE,
    state,
    ...(interactive ? { prompt: 'select_account' } : { prompt: 'none' }),
    ...(hint ? { login_hint: hint } : {})
  }).toString()
  return url.href
}

export async function signIn(interactive: boolean, hint = ''): Promise<string> {
  if (!navigator.onLine) throw new OfflineError('Offline')
  // Comes back with the answer: one that doesn't carry it wasn't asked for by this sign-in.
  const state = crypto.randomUUID()
  let result: string
  try {
    result = await browser.identity.launchWebAuthFlow({ url: authUrl(interactive, hint, state), interactive })
  } catch {
    throw new SignInError('Google sign-in needs the user')
  }
  const answer = new URLSearchParams(new URL(result).hash.slice(1))
  if (answer.get('state') !== state) throw new SignInError('Google sign-in answered another request')
  const token = answer.get('access_token')
  if (!token) throw new SignInError('Google sign-in gave no token')
  await browser.storage.session.set({ [TOKEN]: token })
  return token
}

export const forgetToken = (): Promise<void> => browser.storage.session.remove(TOKEN)

// Takes back FireDial's access to Drive, so it leaves the user's list of connected apps.
export async function revokeAccess(): Promise<void> {
  const stored: Record<string, unknown> = await browser.storage.session.get(TOKEN)
  const token = stored[TOKEN]
  await forgetToken()
  if (typeof token !== 'string') return
  const response = await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token }) }).catch(() => null)
  if (!response?.ok) console.warn('FireDial sync: access not removed', response?.status ?? 'offline')
}

export function googleAuth(hint: () => Promise<string>): Auth {
  return {
    async token() {
      const stored: Record<string, unknown> = await browser.storage.session.get(TOKEN)
      const token = stored[TOKEN]
      return typeof token === 'string' ? token : signIn(false, await hint())
    },
    async renew() {
      return signIn(false, await hint())
    }
  }
}

// Chrome's navigator.userAgentData, which TypeScript doesn't know yet.
const UserAgentData = z.catch(z.object({ brands: z.array(z.object({ brand: z.string() })) }), { brands: [] })

const SYSTEMS: Readonly<Record<string, string>> = { win: 'Windows', mac: 'macOS', linux: 'Linux', cros: 'ChromeOS', android: 'Android', openbsd: 'OpenBSD' }

// "Firefox on Windows": which browser made the last change, as the Sync section shows it.
export async function deviceName(): Promise<string> {
  const { os } = await browser.runtime.getPlatformInfo()
  const { brands } = UserAgentData.parse(Reflect.get(navigator, 'userAgentData'))
  const brand = brands.map((each) => each.brand).find((name) => !/chromium|not.?a.?brand/i.test(name))
  const name = IS_CHROME ? (brand ?? 'Chrome').replace(/^(Google|Microsoft) /, '') : 'Firefox'
  return `${name} on ${SYSTEMS[os] ?? os}`
}
