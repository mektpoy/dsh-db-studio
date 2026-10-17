/**
 * Application service shared by the agent tool and the HTTP routes.
 *
 * Both callers run the same code, so a query issued from the panel and a query
 * issued by the model follow one set of rules: which connection may be written
 * to, how many rows come back, and what lands in the history.
 *
 * Every method that touches a database is asynchronous because the PostgreSQL
 * driver is; the SQLite driver answers immediately but implements the same
 * contract.
 */

import { SqliteDriver } from './sqlite-driver.js'
import { inspectScript, toCsv, toJson } from './sql.js'

/** Hard ceiling on rows returned to a caller; callers may ask for fewer. */
export const MAX_ROWS = 5000

/** Load the PostgreSQL driver only when a connection needs it. */
async function openPostgres(connection) {
  let module
  try {
    module = await import('./postgres-driver.js')
  } catch (error) {
    throw new Error(
      'PostgreSQL connections need the pg package installed with this plugin: ' + (error?.message || error),
    )
  }
  return new module.PostgresDriver(connection)
}

/**
 * One place decides which driver a saved connection opens with.
 *
 * @param {object} connection saved row plus the resolved password
 */
export async function openDriver(connection) {
  const driver = connection.driver || 'sqlite'
  if (driver === 'postgres') return openPostgres(connection)
  if (driver === 'sqlite') {
    return new SqliteDriver({ path: connection.path, readOnly: connection.readOnly })
  }
  throw new Error(`driver ${driver} is not supported by this build`)
}

export class Studio {
  /**
   * @param {{
   *   store: import('./store.js').StudioStore,
   *   defaultReadOnly?: boolean,
   *   secrets?: { get: (id: string) => Promise<string|undefined>, set: (id: string, value: string) => Promise<void>, clear: (id: string) => Promise<void> },
   * }} options
   */
  constructor({ store, defaultReadOnly = true, secrets = null }) {
    this.store = store
    /** Applied when a saved connection does not state its own access mode. */
    this.defaultReadOnly = defaultReadOnly === true
    /** Password storage; without one, a PostgreSQL connection has no password. */
    this.secrets = secrets
  }

  listConnections() {
    return this.store.listConnections().map(connection => ({
      ...connection,
      driver: connection.driver || 'sqlite',
    }))
  }

  /**
   * Create or update a connection, storing the password separately from the row.
   *
   * @param {object} input
   * @returns {Promise<{ id: string }>}
   */
  async saveConnection(input) {
    const saved = this.store.saveConnection({
      ...input,
      readOnly: input.readOnly === undefined ? this.defaultReadOnly : input.readOnly === true,
    })
    if (this.secrets && typeof input.password === 'string') {
      if (input.password === '') await this.secrets.clear(saved.id)
      else await this.secrets.set(saved.id, input.password)
    }
    return saved
  }

  /** @param {string} id */
  async deleteConnection(id) {
    if (this.secrets) {
      try { await this.secrets.clear(id) } catch { /* the row goes either way */ }
    }
    return this.store.deleteConnection(id)
  }

  /** Resolve a saved connection or throw a message the caller can show as-is. */
  requireConnection(id) {
    const connection = this.store.getConnection(String(id || ''))
    if (!connection) throw new Error(`no saved connection with id ${id}`)
    return connection
  }

  /**
   * Open a driver for one operation and close it afterwards. Opening per request
   * keeps no handle or lock alive between calls and picks up a changed password.
   *
   * @template T
   * @param {string} id connection id
   * @param {(driver: any, connection: object) => Promise<T> | T} operation
   * @returns {Promise<T>}
   */
  async use(id, operation) {
    const connection = this.requireConnection(id)
    const password = this.secrets ? await this.secrets.get(connection.id) : undefined
    const driver = await openDriver({ ...connection, password })
    try {
      if (typeof driver.open === 'function') await driver.open()
      return await operation(driver, connection)
    } finally {
      if (typeof driver.close === 'function') await driver.close()
    }
  }

  async test(id) {
    return this.use(id, driver => driver.test())
  }

  /** Tables and views. `table` narrows the answer to one object's full description. */
  async schema(id, table) {
    return this.use(id, async (driver, connection) => {
      if (table) {
        return { connection, detail: await driver.describe(table) }
      }
      let stats = null
      try { stats = await driver.stats() } catch { stats = null }
      return { connection, objects: await driver.objects(), stats }
    })
  }

  /**
   * Object names only, without row counts. Used to describe a database in the
   * prompt, where counting every table would cost more than it explains.
   *
   * @param {string} id
   * @returns {Promise<string[]>}
   */
  async objectNames(id) {
    return this.use(id, async driver => {
      const objects = await driver.objects({ withCounts: false })
      return objects.map(object => object.name)
    })
  }

  async preview(id, table, options) {
    return this.use(id, driver => driver.preview(table, options))
  }

  /**
   * Run a script and record it in the history.
   *
   * @param {string} id
   * @param {string} sql
   * @param {{ maxRows?: number, allowWrite?: boolean }} [options]
   */
  async query(id, sql, options = {}) {
    const started = Date.now()
    try {
      const result = await this.use(id, driver => driver.run(sql, {
        maxRows: Math.min(Number(options.maxRows) || 200, MAX_ROWS),
        allowWrite: options.allowWrite === true,
      }))
      const rowCount = result.statements.reduce((sum, part) => sum + part.rowCount, 0)
      this.store.recordHistory({
        connectionId: id, sql, ok: true, durationMs: result.durationMs, rowCount,
      })
      return result
    } catch (error) {
      this.store.recordHistory({
        connectionId: id, sql, ok: false, error: error?.message || String(error), durationMs: Date.now() - started,
      })
      throw error
    }
  }

  async explain(id, sql) {
    return this.use(id, driver => driver.explain(sql))
  }

  async stats(id) {
    return this.use(id, driver => driver.stats())
  }

  /**
   * Export either a script's result or one table, as CSV or JSON.
   *
   * @param {string} id
   * @param {{ sql?: string, table?: string, format?: 'csv' | 'json', maxRows?: number }} request
   * @returns {Promise<{ body: string, filename: string, contentType: string, rows: number }>}
   */
  async exportData(id, request) {
    const format = request.format === 'json' ? 'json' : 'csv'
    const maxRows = Math.min(Number(request.maxRows) || 5000, MAX_ROWS)
    const connection = this.requireConnection(id)
    const data = await this.use(id, async driver => {
      if (request.sql) {
        const script = inspectScript(request.sql)
        if (script.statements.length === 0) throw new Error('the statement is empty')
        if (script.hasWrite) throw new Error('export runs read statements only')
        return driver.run(request.sql, { maxRows })
      }
      if (!request.table) throw new Error('export needs either sql or table')
      return driver.preview(request.table, { limit: maxRows, offset: 0 })
    })
    const part = data.statements ? data.statements[0] : data
    const columns = part.columns.map(column => column.name)
    // `query` hands back arrays; `preview` hands back objects keyed by column.
    const rows = part.rows.length === 0 || Array.isArray(part.rows[0])
      ? part.rows
      : part.rows.map(row => columns.map(name => row[name]))
    const base = (request.table || 'query').replace(/[^\w.-]+/g, '_')
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    return {
      body: format === 'csv' ? toCsv(columns, rows) : toJson(columns, rows),
      filename: `${connection.name.replace(/[^\w.-]+/g, '_')}-${base}-${stamp}.${format}`,
      contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      rows: rows.length,
    }
  }

  history(connectionId, limit) {
    return this.store.listHistory({ connectionId, limit })
  }

  clearHistory(connectionId) {
    this.store.clearHistory(connectionId)
  }
}
