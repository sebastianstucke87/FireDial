// Submits a build to Edge Add-ons: uploads the package as the draft, then publishes the draft for
// review. Each step runs on Microsoft's side; its operation is followed until it succeeds or fails.
// node scripts/edge-add-ons.ts <package.zip> <notes for certification>
// Needs EDGE_ADD_ONS_CLIENT_ID, EDGE_ADD_ONS_API_KEY and EDGE_ADD_ONS_PRODUCT_ID.

import { readFileSync } from 'node:fs'
import * as z from 'zod/mini'

const POLL = 5000 // ms between looks at an operation
const LIMIT = 5 * 60_000 // ms an operation may take

const need = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is missing`)
  return value
}

const product = `https://api.addons.microsoftedge.microsoft.com/v1/products/${need('EDGE_ADD_ONS_PRODUCT_ID')}`
const auth = { Authorization: `ApiKey ${need('EDGE_ADD_ONS_API_KEY')}`, 'X-ClientID': need('EDGE_ADD_ONS_CLIENT_ID') }

const Operation = z.object({
  status: z.string(),
  message: z.optional(z.nullable(z.string())),
  errors: z.optional(z.nullable(z.array(z.unknown())))
})

// Starts a step; answers with the id of its operation, the last part of the Location header.
async function start(url: string, type: string, body: Blob | string): Promise<string> {
  const response = await fetch(url, { method: 'POST', headers: { ...auth, 'Content-Type': type }, body })
  const operation = response.headers.get('location')?.split('/').pop()
  if (response.status !== 202 || !operation) throw new Error(`${url}: ${response.status} ${await response.text()}`)
  return operation
}

async function follow(url: string, what: string): Promise<void> {
  const end = Date.now() + LIMIT
  for (;;) {
    const response = await fetch(url, { headers: auth })
    const operation = Operation.parse(await response.json())
    console.log(`${what}: ${operation.status}${operation.message ? `, ${operation.message}` : ''}`)
    if (operation.status === 'Succeeded') return
    if (operation.status !== 'InProgress') throw new Error(`${what} failed: ${JSON.stringify(operation)}`)
    if (Date.now() > end) throw new Error(`${what} still in progress after ${LIMIT / 60_000} minutes`)
    await new Promise((resolve) => setTimeout(resolve, POLL))
  }
}

const [file, notes = ''] = process.argv.slice(2)
if (!file) throw new Error('Which package?')

const upload = await start(`${product}/submissions/draft/package`, 'application/zip', new Blob([readFileSync(file)]))
await follow(`${product}/submissions/draft/package/operations/${upload}`, 'Upload')

const publish = await start(`${product}/submissions`, 'application/json', JSON.stringify({ notes }))
await follow(`${product}/submissions/operations/${publish}`, 'Publish')
