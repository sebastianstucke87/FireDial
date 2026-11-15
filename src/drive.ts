import * as z from 'zod/mini'

// The user's Google Drive, only FireDial's own hidden app folder in it (scope drive.appdata):
// nobody else's files, and nothing the user sees among their own. Sync talks to the Drive
// interface, so tests use a fake.

export interface DriveFile {
  id: string
  name: string
  props: Record<string, string> // appProperties: small values read without downloading the file
}

export interface Drive {
  list(): Promise<DriveFile[]>
  read(id: string): Promise<string>
  create(name: string, content: string, props?: Record<string, string>): Promise<DriveFile>
  update(id: string, content: string, props?: Record<string, string>): Promise<void>
  remove(id: string): Promise<void>
  email(): Promise<string>
}

// No connection: try again later.
export class OfflineError extends Error {}
// The sign-in ran out and couldn't be renewed without the user.
export class SignInError extends Error {}

export interface Auth {
  token(): Promise<string> // the one in hand
  renew(): Promise<string> // a fresh one, without asking the user; SignInError if that needs them
}

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FIELDS = 'id,name,appProperties'

const RawFile = z.object({ id: z.string(), name: z.catch(z.string(), ''), appProperties: z.catch(z.record(z.string(), z.string()), {}) })
type RawFile = z.infer<typeof RawFile>
const ListPage = z.object({ files: z.catch(z.array(RawFile), []), nextPageToken: z.catch(z.string(), '') })
const About = z.object({ user: z.catch(z.object({ emailAddress: z.catch(z.string(), '') }), { emailAddress: '' }) })

const toFile = (raw: RawFile): DriveFile => ({ id: raw.id, name: raw.name, props: raw.appProperties })

// Metadata and content in one request.
function multipart(metadata: object, content: string): { body: string; type: string } {
  const boundary = `firedial-${crypto.randomUUID()}`
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    content,
    `--${boundary}--`,
    ''
  ].join('\r\n')
  return { body, type: `multipart/related; boundary=${boundary}` }
}

export class GoogleDrive implements Drive {
  private readonly auth: Auth
  private readonly fetch: typeof fetch // called as a method, so not the browser's own fetch: that needs its window

  constructor(auth: Auth, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.auth = auth
    this.fetch = fetcher
  }

  private async send(url: string, init: RequestInit = {}, type = ''): Promise<Response> {
    const attempt = async (token: string): Promise<Response> => {
      try {
        return await this.fetch(url, { ...init, headers: { ...(type ? { 'Content-Type': type } : {}), Authorization: `Bearer ${token}` } })
      } catch (error) {
        throw new OfflineError('No connection to Google Drive', { cause: error })
      }
    }
    let response = await attempt(await this.auth.token())
    if (response.status === 401) response = await attempt(await this.auth.renew())
    if (response.status === 401) throw new SignInError('Google sign-in ran out')
    if (!response.ok) {
      // Busy or down: like being offline, it passes.
      if (response.status === 429 || response.status >= 500) throw new OfflineError(`Google Drive: ${response.status}`)
      throw new Error(`Google Drive: ${response.status} ${await response.text()}`)
    }
    return response
  }

  async list(): Promise<DriveFile[]> {
    const files: DriveFile[] = []
    let page = ''
    do {
      const query = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '1000', fields: `nextPageToken,files(${FIELDS})` })
      if (page) query.set('pageToken', page)
      const data = ListPage.parse(await (await this.send(`${API}/files?${query}`)).json())
      files.push(...data.files.map(toFile))
      page = data.nextPageToken
    } while (page)
    return files
  }

  async read(id: string): Promise<string> {
    return (await this.send(`${API}/files/${encodeURIComponent(id)}?alt=media`)).text()
  }

  async create(name: string, content: string, props: Record<string, string> = {}): Promise<DriveFile> {
    const { body, type } = multipart({ name, parents: ['appDataFolder'], appProperties: props }, content)
    const response = await this.send(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, { method: 'POST', body }, type)
    return toFile(RawFile.parse(await response.json()))
  }

  async update(id: string, content: string, props: Record<string, string> = {}): Promise<void> {
    const { body, type } = multipart({ appProperties: props }, content)
    await this.send(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=multipart&fields=id`, { method: 'PATCH', body }, type)
  }

  async remove(id: string): Promise<void> {
    try {
      await this.send(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' })
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('Google Drive: 404'))) throw error // gone already
    }
  }

  async email(): Promise<string> {
    return About.parse(await (await this.send(`${API}/about?fields=user(emailAddress)`)).json()).user.emailAddress
  }
}
