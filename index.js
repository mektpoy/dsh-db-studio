/**
 * dsh-db-studio — Host half.
 *
 * Registers the HTTP routes the panel calls, the `db` tool the model calls, and a
 * prompt section that tells the model which databases are available. Everything
 * goes through one Studio service; the rules for read-only access and row limits
 * live there, not in either caller.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StudioStore, defaultStateDir } from './lib/store.js'
import { Studio } from './lib/studio.js'
import { registerRoutes } from './lib/routes.js'
import { dbTool } from './lib/tool.js'
import { sqliteStatus } from './lib/sqlite-driver.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))

/** How long a rendered connection digest is reused before the schema is read again. */
const DIGEST_TTL_MS = 60000
/** Characters the prompt section may spend; the rest of the answer belongs to the model. */
const DIGEST_BUDGET = 1400
/** Connections and table names listed per connection before the entry is summarised. */
const DIGEST_CONNECTIONS = 8
const DIGEST_TABLES = 24
/** One unresponsive database must not hold up the whole digest. */
const DIGEST_PROBE_TIMEOUT_MS = 2500

export const name = 'dsh-db-studio'
export const inject = ['webServer', 'tools']

/**
 * Plugin row config.
 *
 * Declared with the standard-schema shape so the bundle stays dependency-free
 * while the Loader still validates what the patch supplies.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-db-studio',
    validate(config) {
      const raw = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
      const issues = []
      if (raw.dataDir !== undefined && raw.dataDir !== null && typeof raw.dataDir !== 'string') {
        issues.push({ message: 'dataDir must be a string' })
      }
      if (raw.allowWriteByDefault !== undefined && typeof raw.allowWriteByDefault !== 'boolean') {
        issues.push({ message: 'allowWriteByDefault must be a boolean' })
      }
      if (issues.length > 0) return { issues }
      return {
        value: {
          dataDir: typeof raw.dataDir === 'string' && raw.dataDir.trim() ? raw.dataDir.trim() : defaultStateDir(),
          allowWriteByDefault: raw.allowWriteByDefault === true,
        },
      }
    },
  },
}

/** Reject after `ms` so one slow connection cannot stall a probe. */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
    if (typeof timer.unref === 'function') timer.unref()
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Passwords live in the Harness credential store, never in the plugin database.
 * The reference is an environment-variable-style name derived from the connection
 * id, so two connections can never share one secret.
 */
export function createSecrets(credentials) {
  const refFor = id => 'DB_STUDIO_PASSWORD_' + String(id).replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  return {
    refFor,
    async get(id) {
      if (!credentials) return undefined
      try {
        const resolved = await credentials.resolve(refFor(id))
        return resolved?.value
      } catch {
        return undefined
      }
    },
    async set(id, value) {
      if (!credentials) {
        throw new Error('this Harness has no credential store, so a PostgreSQL password cannot be saved')
      }
      await credentials.set(refFor(id), value)
    },
    async clear(id) {
      if (!credentials) return
      try { await credentials.unset(refFor(id)) } catch { /* nothing stored */ }
    },
  }
}

/**
 * Build the text the model sees before it calls the tool, so it knows which
 * databases exist and what is in them without spending a tool round trip.
 *
 * The section is read synchronously during prompt assembly, so this returns
 * whatever the last refresh produced and starts a new refresh in the background.
 * A connection that cannot be opened is described as such rather than omitted:
 * "the file is gone" is the fact the user needs.
 */
function createDigest(studio) {
  let text = ''
  let refreshedAt = 0
  let running = false

  const refresh = async () => {
    if (running) return
    running = true
    try {
      const connections = studio.listConnections()
      const lines = []
      for (const connection of connections.slice(0, DIGEST_CONNECTIONS)) {
        const access = connection.readOnly ? 'read-only' : 'writable'
        const target = connection.driver === 'postgres'
          ? `${connection.host}:${connection.port}/${connection.dbname}`
          : connection.path
        let names
        try {
          names = await withTimeout(studio.objectNames(connection.id), DIGEST_PROBE_TIMEOUT_MS)
        } catch (error) {
          lines.push(`- ${connection.name} (${access}): cannot open ${target} (${error.message})`)
          continue
        }
        const shown = names.slice(0, DIGEST_TABLES)
        const rest = names.length - shown.length
        const tables = shown.length === 0 ? 'no tables' : shown.join(', ') + (rest > 0 ? `, +${rest} more` : '')
        lines.push(`- ${connection.name} (${access}): ${tables}`)
      }
      let built = ''
      if (lines.length > 0) {
        built = 'Databases saved in DB Studio. The db tool applies the access mode shown here, '
          + 'so a read-only connection refuses statements that change data:\n' + lines.join('\n')
      }
      if (built.length > DIGEST_BUDGET) {
        built = built.slice(0, DIGEST_BUDGET).trimEnd()
          + '\n... more objects omitted; call db with action "schema" for the full list.'
      }
      text = built
      refreshedAt = Date.now()
    } finally {
      running = false
    }
  }

  return () => {
    if (Date.now() - refreshedAt > DIGEST_TTL_MS) {
      // Deliberately not awaited: prompt assembly must not wait on a database.
      refresh().catch(() => { refreshedAt = Date.now() })
    }
    return text
  }
}

export function apply(ctx, config) {
  const dataDir = config?.dataDir || defaultStateDir()
  // New connections are read-only unless the deployment opts out. Writing is a
  // per-connection decision the user makes explicitly in the panel.
  const defaultReadOnly = config?.allowWriteByDefault !== true

  // Both services are optional: without them the panel and the tool still work,
  // they just lose the prompt digest and PostgreSQL passwords respectively.
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : ctx.systemPrompt
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials

  ctx.effect(() => {
    const store = new StudioStore(dataDir)
    const studio = new Studio({ store, defaultReadOnly, secrets: createSecrets(credentials) })
    const digest = createDigest(studio)
    const disposers = [
      ...registerRoutes(ctx, {
        studio,
        sqliteStatus,
        version: manifest.version,
      }),
      ctx.tools.register(dbTool(studio)),
    ]
    if (systemPrompt) {
      disposers.push(systemPrompt.section({
        name: 'db-studio-connections',
        order: 55,
        text: () => digest(),
      }))
    }
    return () => {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* already disposed */ }
      }
      store.close()
    }
  }, 'dsh-db-studio: routes, tool and prompt section')
}
