/**
 * Plugin state: saved connections and the query history.
 *
 * Both live in one SQLite file under the Harness home directory. They are state,
 * not cache, so they survive restarts, and a single writer (this store) keeps the
 * file consistent even when several sessions run at once.
 *
 * Passwords are not stored here. `Studio` keeps them behind a secret store and
 * only this row's shape is persisted, so the state file never holds a secret.
 */

import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)

let sqliteModule
function sqlite() {
  if (sqliteModule !== undefined) return sqliteModule
  try {
    sqliteModule = require('node:sqlite')
  } catch {
    sqliteModule = null
  }
  return sqliteModule
}

/** Default state directory: `<harness home>/dsh-db-studio`. */
export function defaultStateDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-db-studio')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  driver TEXT NOT NULL DEFAULT 'sqlite',
  path TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 5432,
  dbname TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  ssl INTEGER NOT NULL DEFAULT 0,
  read_only INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS query_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL DEFAULT '',
  sql TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS query_history_at ON query_history (at DESC);
`

/** Columns added after the first release; a stored file gets them in place. */
const ADDED_COLUMNS = {
  host: "TEXT NOT NULL DEFAULT ''",
  port: 'INTEGER NOT NULL DEFAULT 5432',
  dbname: "TEXT NOT NULL DEFAULT ''",
  username: "TEXT NOT NULL DEFAULT ''",
  ssl: 'INTEGER NOT NULL DEFAULT 0',
}

/** One row to the shape the rest of the plugin uses. */
function toConnection(row) {
  return {
    id: row.id,
    name: row.name,
    driver: row.driver || 'sqlite',
    path: row.path || '',
    host: row.host || '',
    port: Number(row.port) || 5432,
    dbname: row.dbname || '',
    username: row.username || '',
    ssl: row.ssl === 1,
    readOnly: row.read_only === 1,
    note: row.note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class StudioStore {
  /** @param {string} [directory] */
  constructor(directory) {
    this.directory = directory || defaultStateDir()
    this.db = null
  }

  open() {
    if (this.db) return this.db
    const mod = sqlite()
    if (!mod) throw new Error('this runtime has no node:sqlite module, so connections cannot be stored')
    mkdirSync(this.directory, { recursive: true })
    const db = new mod.DatabaseSync(join(this.directory, 'studio.db'))
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(SCHEMA)
    const existing = new Set(db.prepare('PRAGMA table_info(connections)').all().map(row => row.name))
    for (const [name, definition] of Object.entries(ADDED_COLUMNS)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE connections ADD COLUMN ${name} ${definition}`)
    }
    this.db = db
    return db
  }

  close() {
    if (!this.db) return
    try { this.db.close() } catch { /* already closed */ }
    this.db = null
  }

  /** @returns {Array<ReturnType<typeof toConnection>>} */
  listConnections() {
    return this.open().prepare('SELECT * FROM connections ORDER BY name COLLATE NOCASE').all().map(toConnection)
  }

  /** @param {string} id */
  getConnection(id) {
    const row = this.open().prepare('SELECT * FROM connections WHERE id = ?').get(String(id))
    return row ? toConnection(row) : null
  }

  /**
   * Create or update a connection.
   *
   * @param {{ id?: string, name: string, driver?: string, path?: string, host?: string, port?: number,
   *   dbname?: string, username?: string, ssl?: boolean, readOnly?: boolean, note?: string }} input
   * @returns {{ id: string }}
   */
  saveConnection(input) {
    const db = this.open()
    const now = Date.now()
    const driver = String(input.driver || 'sqlite')
    const name = String(input.name || '').trim()
    if (!name) throw new Error('a connection needs a name')
    const path = driver === 'sqlite' ? String(input.path || '').trim() : ''
    const host = driver === 'sqlite' ? '' : String(input.host || '').trim()
    const dbname = driver === 'sqlite' ? '' : String(input.dbname || '').trim()
    if (driver === 'sqlite' && !path) throw new Error('a SQLite connection needs a database file path')
    if (driver === 'postgres' && (!host || !dbname)) {
      throw new Error('a PostgreSQL connection needs a host and a database name')
    }
    const port = Number(input.port) > 0 ? Number(input.port) : 5432
    const username = String(input.username || '')
    const ssl = input.ssl === true ? 1 : 0
    const readOnly = input.readOnly === undefined ? true : input.readOnly === true
    const note = String(input.note || '')
    const id = input.id ? String(input.id) : randomUUID()
    const existing = input.id ? this.getConnection(id) : null
    if (existing) {
      db.prepare(
        `UPDATE connections SET name = ?, driver = ?, path = ?, host = ?, port = ?, dbname = ?, username = ?,
           ssl = ?, read_only = ?, note = ?, updated_at = ? WHERE id = ?`,
      ).run(name, driver, path, host, port, dbname, username, ssl, readOnly ? 1 : 0, note, now, id)
    } else {
      db.prepare(
        `INSERT INTO connections (id, name, driver, path, host, port, dbname, username, ssl, read_only, note,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, name, driver, path, host, port, dbname, username, ssl, readOnly ? 1 : 0, note, now, now)
    }
    return { id }
  }

  /** @param {string} id @returns {boolean} whether a row was removed */
  deleteConnection(id) {
    const db = this.open()
    const info = db.prepare('DELETE FROM connections WHERE id = ?').run(String(id))
    db.prepare('DELETE FROM query_history WHERE connection_id = ?').run(String(id))
    return Number(info.changes) > 0
  }

  /**
   * @param {{ connectionId?: string, sql: string, ok: boolean, error?: string, durationMs?: number, rowCount?: number }} entry
   */
  recordHistory(entry) {
    const db = this.open()
    db.prepare(
      `INSERT INTO query_history (connection_id, sql, ok, error, duration_ms, row_count, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      String(entry.connectionId || ''),
      String(entry.sql || '').slice(0, 20000),
      entry.ok ? 1 : 0,
      String(entry.error || '').slice(0, 2000),
      Number(entry.durationMs) || 0,
      Number(entry.rowCount) || 0,
      Date.now(),
    )
    // Keep the history bounded; the oldest entries are the ones no one reads.
    db.prepare(
      'DELETE FROM query_history WHERE id NOT IN (SELECT id FROM query_history ORDER BY at DESC LIMIT 500)',
    ).run()
  }

  /**
   * @param {{ connectionId?: string, limit?: number }} [options]
   * @returns {Array<{ id: number, connectionId: string, sql: string, ok: boolean, error: string, durationMs: number, rowCount: number, at: number }>}
   */
  listHistory(options = {}) {
    const db = this.open()
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200)
    const rows = options.connectionId
      ? db.prepare('SELECT * FROM query_history WHERE connection_id = ? ORDER BY at DESC LIMIT ?').all(String(options.connectionId), limit)
      : db.prepare('SELECT * FROM query_history ORDER BY at DESC LIMIT ?').all(limit)
    return rows.map(row => ({
      id: row.id,
      connectionId: row.connection_id,
      sql: row.sql,
      ok: row.ok === 1,
      error: row.error || '',
      durationMs: row.duration_ms,
      rowCount: row.row_count,
      at: row.at,
    }))
  }

  clearHistory(connectionId) {
    const db = this.open()
    if (connectionId) db.prepare('DELETE FROM query_history WHERE connection_id = ?').run(String(connectionId))
    else db.prepare('DELETE FROM query_history').run()
  }
}
