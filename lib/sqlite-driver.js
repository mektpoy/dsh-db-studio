/**
 * SQLite driver built on the runtime's own `node:sqlite`, so the plugin needs no
 * npm dependency to be useful.
 *
 * Every method here is synchronous. `node:sqlite` has no asynchronous API, so a
 * long query blocks the Host event loop; callers cap the row count and the UI
 * keeps queries to page-sized statements.
 */

import { createRequire } from 'node:module'
import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  encodeCell, inspectScript, quoteIdent, splitStatements, classifyStatement,
} from './sql.js'

const require = createRequire(import.meta.url)

let sqliteModule
/** Lazily resolve `node:sqlite`; older runtimes return null instead of crashing the Host. */
function sqlite() {
  if (sqliteModule !== undefined) return sqliteModule
  try {
    sqliteModule = require('node:sqlite')
  } catch {
    sqliteModule = null
  }
  return sqliteModule
}

/** @returns {{ available: boolean, reason?: string }} */
export function sqliteStatus() {
  const mod = sqlite()
  if (!mod || typeof mod.DatabaseSync !== 'function') {
    return { available: false, reason: 'this runtime has no node:sqlite module' }
  }
  return { available: true }
}

/** Columns of the result set, falling back to the first row's keys. */
function columnsOf(statement, rows) {
  if (typeof statement.columns === 'function') {
    try {
      const described = statement.columns()
      if (Array.isArray(described) && described.length > 0) {
        return described.map(column => ({ name: column.name, type: column.type || '', table: column.table || '' }))
      }
    } catch {
      /* fall through to the row keys */
    }
  }
  return rows.length > 0 ? Object.keys(rows[0]).map(name => ({ name, type: '', table: '' })) : []
}

/**
 * Count rows without scanning a huge table: the subquery stops after
 * `COUNT_CAP + 1` rows, so a table with millions of rows costs the same as one
 * with `COUNT_CAP`. Callers report the cap instead of pretending the number is
 * exact.
 */
const COUNT_CAP = 100000

function countRows(db, table) {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${quoteIdent(table)} LIMIT ${COUNT_CAP + 1})`,
  ).get()
  const value = Number(row?.n ?? 0)
  return value > COUNT_CAP ? { rows: COUNT_CAP, capped: true } : { rows: value, capped: false }
}

/** Statement text is echoed back so the client can show what actually ran. */
export class SqliteDriver {
  /**
   * @param {{ path: string, readOnly?: boolean }} connection
   */
  constructor(connection) {
    this.connection = connection
    this.db = null
  }

  /** Open the database file. A read-only open fails when the file does not exist. */
  open() {
    if (this.db) return this.db
    const mod = sqlite()
    if (!mod) throw new Error('this runtime has no node:sqlite module')
    const path = this.connection.path
    const db = new mod.DatabaseSync(path, { readOnly: this.connection.readOnly === true })
    try {
      db.exec('PRAGMA busy_timeout = 5000')
    } catch {
      /* busy_timeout is best effort */
    }
    this.db = db
    return db
  }

  close() {
    if (!this.db) return
    try { this.db.close() } catch { /* already closed */ }
    this.db = null
  }

  /** Round-trip the connection; returns the SQLite version and file facts. */
  test() {
    const db = this.open()
    const version = db.prepare('SELECT sqlite_version() AS version').get()?.version ?? ''
    let bytes = 0
    try { bytes = statSync(this.connection.path).size } catch { /* in-memory or missing */ }
    return { ok: true, version, bytes, path: this.connection.path, readOnly: this.connection.readOnly === true }
  }

  /** Tables and views with their row counts, ordered by name. */
  objects(options = {}) {
    const db = this.open()
    const rows = db.prepare(
      `SELECT name, type, sql FROM sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    ).all()
    return rows.map(row => {
      const entry = { name: row.name, type: row.type, rows: null, rowsCapped: false }
      // A count on a view or a virtual table can be expensive or unsupported;
      // report null instead of failing the whole listing.
      if (options.withCounts === false) return entry
      try {
        if (row.type === 'table') {
          const counted = countRows(db, row.name)
          entry.rows = counted.rows
          entry.rowsCapped = counted.capped
        }
      } catch {
        entry.rows = null
      }
      return entry
    })
  }

  /** Column, index, foreign-key and DDL facts for one table or view. */
  describe(name) {
    const db = this.open()
    const table = String(name)
    const master = db.prepare(
      `SELECT name, type, sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')`,
    ).get(table)
    if (!master) throw new Error(`no table or view named ${table}`)
    const columns = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(row => ({
      name: row.name,
      type: row.type,
      notNull: row.notnull === 1,
      defaultValue: row.dflt_value,
      primaryKey: row.pk > 0,
      primaryKeyOrder: row.pk,
    }))
    const indexes = []
    if (master.type === 'table') {
      for (const index of db.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all()) {
        let parts = []
        try {
          parts = db.prepare(`PRAGMA index_info(${quoteIdent(index.name)})`).all()
            .sort((a, b) => a.seqno - b.seqno)
            .map(part => part.name || `<expr ${part.cid}>`)
        } catch {
          /* expression indexes may not resolve through index_info */
        }
        indexes.push({ name: index.name, unique: index.unique === 1, origin: index.origin, columns: parts })
      }
    }
    const foreignKeys = master.type === 'table'
      ? db.prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`).all().map(row => ({
        id: row.id, table: row.table, from: row.from, to: row.to,
        onUpdate: row.on_update, onDelete: row.on_delete,
      }))
      : []
    let rows = null
    let rowsCapped = false
    try {
      const counted = countRows(db, table)
      rows = counted.rows
      rowsCapped = counted.capped
    } catch {
      rows = null
    }
    return {
      name: master.name, type: master.type, ddl: master.sql || '', columns, indexes, foreignKeys, rows, rowsCapped,
    }
  }

  /**
   * One page of table data.
   *
   * @param {string} name table or view
   * @param {{ limit?: number, offset?: number, orderBy?: string, dir?: string, search?: string, filters?: Record<string, string> }} [options]
   */
  preview(name, options = {}) {
    const db = this.open()
    const table = String(name)
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 1000)
    const offset = Math.max(Number(options.offset) || 0, 0)
    const clauses = []
    const params = []
    // `search` matches the substring in any column, which is what a single
    // search box should do; `filters` narrows named columns.
    const search = String(options.search ?? '').trim()
    if (search) {
      const names = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(row => row.name)
      if (names.length > 0) {
        clauses.push('(' + names.map(column => `CAST(${quoteIdent(column)} AS TEXT) LIKE ?`).join(' OR ') + ')')
        for (let index = 0; index < names.length; index += 1) params.push(`%${search}%`)
      }
    }
    for (const [column, value] of Object.entries(options.filters || {})) {
      if (value === undefined || value === null || value === '') continue
      clauses.push(`CAST(${quoteIdent(column)} AS TEXT) LIKE ?`)
      params.push(`%${String(value)}%`)
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    const dir = String(options.dir || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
    const order = options.orderBy ? ` ORDER BY ${quoteIdent(options.orderBy)} ${dir}` : ''
    // Ask for one extra row to learn whether another page exists without a count.
    const statement = db.prepare(
      `SELECT * FROM ${quoteIdent(table)}${where}${order} LIMIT ? OFFSET ?`,
    )
    const raw = statement.all(...params, limit + 1, offset)
    const truncated = raw.length > limit
    const rows = (truncated ? raw.slice(0, limit) : raw).map(row => {
      const encoded = {}
      for (const key of Object.keys(row)) encoded[key] = encodeCell(row[key])
      return encoded
    })
    const columns = columnsOf(statement, raw)
    let total = null
    let totalCapped = false
    try {
      const counted = db.prepare(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${quoteIdent(table)}${where} LIMIT ${COUNT_CAP + 1})`,
      ).get(...params)
      const value = Number(counted?.n ?? 0)
      total = Math.min(value, COUNT_CAP)
      totalCapped = value > COUNT_CAP
    } catch {
      total = null
    }
    return {
      table, columns, rows, total, totalCapped, limit, offset,
      hasMore: truncated || (total !== null && offset + rows.length < total),
    }
  }

  /**
   * Execute a script. Read-only connections refuse anything that is not a read;
   * on a writable connection several statements run inside one transaction.
   *
   * @param {string} sql
   * @param {{ maxRows?: number, allowWrite?: boolean }} [options]
   */
  run(sql, options = {}) {
    const db = this.open()
    const started = Date.now()
    const maxRows = Math.min(Math.max(Number(options.maxRows) || 500, 1), 5000)
    const { statements, verdicts, hasWrite } = inspectScript(sql)
    if (statements.length === 0) throw new Error('the statement is empty')
    const readOnly = this.connection.readOnly === true
    if (readOnly && hasWrite) {
      const first = verdicts.findIndex(verdict => verdict !== 'read')
      throw new Error(
        `read-only connection refuses statement ${first + 1} (${classifyStatement(statements[first])}); `
        + 'open the connection with write access to run it',
      )
    }
    if (options.allowWrite !== true && hasWrite) {
      throw new Error('this tool call is not allowed to change the database; pass allowWrite')
    }

    const results = []
    let changes = 0
    const transactional = statements.length > 1 && hasWrite
    if (transactional) db.exec('BEGIN')
    try {
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index]
        const verdict = verdicts[index]
        const prepared = db.prepare(statement)
        if (verdict === 'read' || /\breturning\b/i.test(statement)) {
          const raw = prepared.all()
          const truncated = raw.length > maxRows
          const kept = truncated ? raw.slice(0, maxRows) : raw
          const columns = columnsOf(prepared, raw)
          results.push({
            statement: index + 1,
            sql: statement,
            columns,
            rows: kept.map(row => columns.map(column => encodeCell(row[column.name]))),
            rowCount: raw.length,
            truncated,
            changes: 0,
          })
        } else {
          const info = prepared.run()
          const changed = Number(info?.changes ?? 0)
          changes += changed
          results.push({
            statement: index + 1,
            sql: statement,
            columns: [],
            rows: [],
            rowCount: 0,
            truncated: false,
            changes: changed,
          })
        }
      }
      if (transactional) db.exec('COMMIT')
    } catch (error) {
      if (transactional) {
        try { db.exec('ROLLBACK') } catch { /* the transaction may already be gone */ }
      }
      throw error
    }
    return {
      statements: results,
      changes,
      durationMs: Date.now() - started,
      readOnly,
    }
  }

  /** `EXPLAIN QUERY PLAN` rows for one statement. */
  explain(sql) {
    const db = this.open()
    const statements = splitStatements(sql)
    if (statements.length === 0) throw new Error('the statement is empty')
    const prepared = db.prepare(`EXPLAIN QUERY PLAN ${statements[0]}`)
    const raw = prepared.all()
    const columns = columnsOf(prepared, raw)
    return {
      columns,
      rows: raw.map(row => columns.map(column => encodeCell(row[column.name]))),
    }
  }

  /** Database-level facts: page size, page count, freelist, schema version, file size. */
  stats() {
    const db = this.open()
    const read = (pragma) => {
      try {
        const row = db.prepare(`PRAGMA ${pragma}`).get()
        return row ? Object.values(row)[0] : null
      } catch {
        return null
      }
    }
    const pageCount = Number(read('page_count') ?? 0)
    const pageSize = Number(read('page_size') ?? 0)
    let fileBytes = 0
    try { fileBytes = statSync(this.connection.path).size } catch { /* in-memory or missing */ }
    return {
      path: this.connection.path,
      directory: dirname(this.connection.path),
      pageSize,
      pageCount,
      freelistPages: Number(read('freelist_count') ?? 0),
      schemaVersion: read('user_version'),
      journalMode: read('journal_mode'),
      encoding: read('encoding'),
      foreignKeys: Number(read('foreign_keys') ?? 0) === 1,
      bytes: fileBytes,
    }
  }
}

export { splitStatements, classifyStatement }
