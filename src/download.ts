// Saving a file, and knowing that it was saved.

interface DownloadOptions {
  url: string
  filename: string
  conflictAction: 'uniquify'
  saveAs?: boolean
}

interface DownloadChange {
  id: number
  state?: { current?: string }
  error?: { current?: string }
}

interface FoundDownload {
  state: string
  error?: string | undefined
}

export interface DownloadApi {
  download(options: DownloadOptions): Promise<number>
  search(query: { id: number }): Promise<FoundDownload[]>
  onChanged: {
    addListener(listener: (change: DownloadChange) => void): void
    removeListener(listener: (change: DownloadChange) => void): void
  }
}

function finished(api: DownloadApi, id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (state: string | undefined, error: string | undefined): void => {
      if (state !== 'complete' && state !== 'interrupted') return
      api.onChanged.removeListener(onChange)
      if (state === 'complete') resolve()
      else reject(new Error(error ?? 'The download failed'))
    }
    const onChange = (change: DownloadChange): void => {
      if (change.id === id) settle(change.state?.current, change.error?.current)
    }
    api.onChanged.addListener(onChange)
    // It may be over already: a small file doesn't wait for the listener.
    api.search({ id }).then(([item]) => {
      settle(item?.state, item?.error)
    }, reject)
  })
}

// Resolves once the file is on disk. A silent save goes straight to the downloads folder,
// whatever Firefox is set to ask.
export async function saveFile(api: DownloadApi, url: string, filename: string, silent: boolean): Promise<void> {
  const id = await api.download({ url, filename, conflictAction: 'uniquify', ...(silent ? { saveAs: false } : {}) })
  await finished(api, id)
}
