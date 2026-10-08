#!/usr/bin/env node
import { createServer } from 'node:http'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { loadConfig } from './config.ts'
import { Store } from './db.ts'
import { createHandler } from './server.ts'

const SWEEP_INTERVAL_MS = 60 * 60 * 1000

const config = loadConfig()
const store = new Store(config.databasePath)

async function sweepExpired(): Promise<void> {
  for (const key of store.expired()) {
    await rm(join(config.mediaDir, `${key}.webm`), { force: true }).catch(() => {})
    store.remove(key)
  }
}

const server = createServer((req, res) => {
  void createHandler({ config, store })(req, res)
})

server.listen(config.port, config.host, () => {
  console.log(`butterfly-share listening on http://${config.host}:${config.port}`)
  console.log(`  public url    ${config.publicUrl}`)
  console.log(`  data          ${config.dataDir}`)
  console.log(`  upload token  ${config.uploadToken}`)
  console.log('')
  console.log('In the Butterfly Record extension, open a recording in the library and enter')
  console.log('the public url and that token in its Share panel.')
  console.log('Keep it secret: it is what stops strangers uploading to your server.')
})

void sweepExpired()
const sweep = setInterval(() => void sweepExpired(), SWEEP_INTERVAL_MS)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(sweep)
    server.close(() => {
      store.close()
      process.exit(0)
    })
  })
}
