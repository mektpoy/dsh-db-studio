/**
 * Application service shared by the agent tool and the HTTP routes.
 *
 * Both callers run the same code, so a query issued from the panel and a query
 * issued by the model follow one set of rules: which connection may be written
 * to, how many rows come back, and what lands in the history.
 */

import { SqliteDriver } from './sqlite-driver.js'
import { inspectScript, toCsv, toJson } from './sql.js'

/** Hard ceiling on rows returned to a caller; callers may ask for fewer. */
export const MAX_ROWS = 5000

export class Studio {
  /**
   * @param {{ store: import('./store.js').StudioStore, defaultReadOnly?: boolean }} options
   */
  constructor({ store, defaultReadOnly = true }) {
    this.store = store
    /** Applied when a saved connection does not state its own access mode. */
    this.defaultReadOnly = defaultReadOnly === true
  }

  listConnections() {
    return this.store.listConnections().map(connection => ({
      ...connection,
      driver: connection.driver || 'sqlite',
    }))
  }

  saveConnection(input) {
    return this.store.saveConnection({
      ...input,
      readOnly: input.readOnly === undefined ? this.defaultReadOnly : input.readOnly === true,
    })
  }

  deleteConnection(id) {
    return this.store.deleteConnection(id)
  }

  /** Resolve a saved connection or throw a message the caller can show as-is. */
  requireConnection(id) {
    const connection = this.store.getConnection(String(id || ''))
    if (!connection) throw new Error(`no saved connection with id ${id}`)
    return connection
  }

  /**
   * Open a driver for one operation and close it afterwards. SQLite opens are
   * cheap, and closing keeps no file handle or lock alive between requests.
   *
   * @template T
   * @param {string} id connection id
   * @param {(driver: SqliteDriver, connection: ReturnType<Studio['requireConnection']>) => T} operation
   * @returns {T}
   */
  use(id, operation) {
    const connection = this.requireConnection(id)
    if ((connection.driver || 'sqlite') !== 'sqlite') {
      throw new Error(`driver ${connection.driver} is not supported by this build`)
    }
    const driver = new SqliteDriver({ path: connection.path, readOnly: connection.readOnly })
    try {
      return operation(driver, connection)
    } finally {
      driver.close()
    }
  }

  test(id) {
    return this.use(id, driver => driver.test())
  }

  /** Tables and views. `table` narrows the answer to one object's full description. */
  schema(id, table) {
    return this.use(id, (driver, connection) => {
      if (table) {
        return { connection, detail: driver.describe(table) }
      }
      let stats = null
      try { stats = driver.stats() } catch { stats = null }
      return { connection, objects: driver.objects(), stats }
    })
  }

  preview(id, table, options) {
    return this.use(id, driver => driver.preview(table, options))
  }

  /**
   * Object names only, without row counts. Used to describe a database in the
   * prompt, where counting every table would cost more than it explains.
   *
   * @param {string} id
   * @returns {string[]}
   */
  objectNames(id) {
    return this.use(id, driver => driver.objects({ withCounts: false }).map(object => object.name))
  }

  /**
   * Run a script and record it in the history.
   *
   * @param {string} id
   * @param {string} sql
   * @param {{ maxRows?: number, allowWrite?: boolean }} [options]
   */
  query(id, sql, options = {}) {
    const started = Date.now()
    try {
      const result = this.use(id, driver => driver.run(sql, {
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

  explain(id, sql) {
    return this.use(id, driver => driver.explain(sql))
  }

  stats(id) {
    return this.use(id, driver => driver.stats())
  }

  /**
   * Export either a script's result or one table, as CSV or JSON.
   *
   * @param {string} id
   * @param {{ sql?: string, table?: string, format?: 'csv' | 'json', maxRows?: number }} request
   * @returns {{ body: string, filename: string, contentType: string, rows: number }}
   */
  exportData(id, request) {
    const format = request.format === 'json' ? 'json' : 'csv'
    const maxRows = Math.min(Number(request.maxRows) || 5000, MAX_ROWS)
    const connection = this.requireConnection(id)
    const data = this.use(id, driver => {
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
