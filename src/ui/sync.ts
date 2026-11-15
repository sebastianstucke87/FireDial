// The Sync section in the settings, the first sync's question and the dot on Edit when sync waits
// for the user. The background does the syncing; this page asks it to and shows its status.

import { IS_CHROME } from '../browser.ts'
import { SYNC_DATA, signIn } from '../google.ts'
import { plural } from '../model.ts'
import { browserKeyValue } from '../store.ts'
import { parseSyncState } from '../sync.ts'
import type { SyncCommand, SyncState } from '../sync.ts'
import type { Confirm } from './confirm.ts'
import { $, html } from './dom.ts'
import { Modal } from './modal.ts'

const MINUTE = 60_000 // ms
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const DELETE_FROM_DRIVE = {
  title: 'Delete from Drive',
  text: 'Delete from Drive. This will delete all FireDial sparks, views and previews from your Google Drive, stop sync and remove FireDial’s access to Drive. This browser keeps them.',
  button: 'Delete from Drive'
}

export function ago(at: number, now = Date.now()): string {
  const passed = Math.max(0, now - at)
  if (passed < MINUTE) return 'just now'
  if (passed < HOUR) return `${Math.floor(passed / MINUTE)} min ago`
  if (passed < DAY) return `${Math.floor(passed / HOUR)} h ago`
  return `${Math.floor(passed / DAY)} d ago`
}

export function statusText(state: SyncState, now = Date.now()): string {
  if (state.status === 'offline') return 'Offline · retrying'
  if (state.status === 'signin') return 'Paused · sign in again'
  if (state.status === 'syncing' || !state.last) return 'Syncing…'
  return `Synced ${ago(state.last.at, now)} · ${state.last.device}`
}

const send = (command: SyncCommand): Promise<unknown> => browser.runtime.sendMessage({ sync: command }).catch(() => undefined)

export function initSync(confirm: Confirm): void {
  const modal = new Modal($('#syncModal', HTMLDialogElement), 'Keep which sparks?')
  const off = html('#syncOff')
  const on = html('#syncOn')
  const status = html('#syncStatus')
  const now = $('[data-sync="now"]', HTMLButtonElement)
  const login = $('[data-sync="signin"]', HTMLButtonElement)
  const editToggle = html('#editToggle')
  let state = parseSyncState(undefined)
  let starting = false // this page started sync, so it asks the first sync's question

  function render(): void {
    const running = state.on && state.status !== 'choose'
    off.hidden = running
    on.hidden = !running
    status.textContent = statusText(state)
    const signin = running && state.status === 'signin'
    status.classList.toggle('SyncStatus--alert', signin)
    now.hidden = signin
    login.hidden = !signin
    html('#syncEmail').textContent = state.email
    editToggle.classList.toggle('EditToggle--alert', signin)
  }

  async function ask(): Promise<void> {
    const { choice } = state
    if (!choice) return
    html('#syncDrive').textContent = `${choice.device} · ${ago(choice.at)} · ${plural(choice.sparks, 'spark')}`
    html('#syncLocal').textContent = plural(choice.local, 'spark')
    $('input[value=drive]', HTMLInputElement, modal.form).checked = true
    const answer = await modal.open()
    const from = $('input[value=local]', HTMLInputElement, modal.form).checked ? 'local' : 'drive'
    await send(answer === 'save' ? from : 'stop')
  }

  async function refresh(): Promise<void> {
    state = parseSyncState((await browserKeyValue.get('sync'))['sync'])
    render()
    if (starting && state.status === 'choose') {
      starting = false
      await ask()
    }
  }

  // The click opens Google's sign-in; the background takes it from there.
  async function start(hint = ''): Promise<boolean> {
    try {
      await signIn(true, hint)
      return true
    } catch {
      return false // closed, or no connection: the button is still there
    }
  }

  const commands: Readonly<Record<string, () => Promise<unknown>>> = {
    start: async () => {
      // Firefox asks whether FireDial may send sparks and previews off the computer.
      if (!IS_CHROME && !(await browser.permissions.request({ data_collection: SYNC_DATA }).catch(() => false))) return
      if (!(await start())) return
      starting = true
      await send('start')
    },
    now: () => send('now'),
    signin: async () => {
      if (await start(state.email)) await send('now')
    },
    stop: () => send('stop'),
    delete: async () => {
      if (await confirm.ask(DELETE_FROM_DRIVE)) await send('delete')
    }
  }

  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-sync]') : null
    const run = commands[button?.dataset['sync'] ?? '']
    if (run) void run()
  })
  browserKeyValue.onChanged((keys) => {
    if (keys.has('sync')) void refresh()
  })
  // Newer changes from other browsers come when FireDial is looked at; the background keeps it to
  // one check in a while.
  const pull = (): void => {
    if (document.visibilityState === 'visible' && state.on) void send('pull')
  }
  document.addEventListener('visibilitychange', pull)
  window.addEventListener('focus', pull)
  setInterval(() => {
    if (!on.hidden && document.visibilityState === 'visible') render() // "5 min ago" moves on
  }, MINUTE)
  void refresh().then(pull)
}
