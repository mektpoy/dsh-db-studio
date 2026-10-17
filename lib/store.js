/**
 * Plugin state: saved connections and the query history.
 *
 * Both live in one SQLite file under the Harness home directory. They are state,
 * not cache, so they survive restarts, and a single writer (this store) keeps the
 * file consistent even when several sessions run at once.
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
  path TEXT NOT NULL,
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
    this.db = db
    return db
  }

  close() {
    if (!this.db) return
    try { this.db.close() } catch { /* already closed */ }
    this.db = null
  }

  /** @returns {Array<{ id: string, name: string, driver: string, path: string, readOnly: boolean, note: string, createdAt: number, updatedAt: number }>} */
  listConnections() {
    const db = this.open()
    return db.prepare('SELECT * FROM connections ORDER BY name COLLATE NOCASE').all().map(row => ({
      id: row.id,
      name: row.name,
      driver: row.driver,
      path: row.path,
      readOnly: row.read_only === 1,
      note: row.note || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  /** @param {string} id */
  getConnection(id) {
    const db = this.open()
    const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(String(id))
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      driver: row.driver,
      path: row.path,
      readOnly: row.read_only === 1,
      note: row.note || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Create or update a connection.
   *
   * @param {{ id?: string, name: string, path: string, readOnly?: boolean, note?: string, driver?: string }} input
   * @returns {{ id: string }}
   */
  saveConnection(input) {
    const db = this.open()
    const now = Date.now()
    const name = String(input.name || '').trim()
    const path = String(input.path || '').trim()
    if (!name) throw new Error('a connection needs a name')
    if (!path) throw new Error('a connection needs a database file path')
    const readOnly = input.readOnly === undefined ? true : input.readOnly === true
    const note = String(input.note || '')
    const driver = String(input.driver || 'sqlite')
    const id = input.id ? String(input.id) : randomUUID()
    const existing = input.id ? this.getConnection(id) : null
    if (existing) {
      db.prepare(
        'UPDATE connections SET name = ?, path = ?, read_only = ?, note = ?, driver = ?, updated_at = ? WHERE id = ?',
      ).run(name, path, readOnly ? 1 : 0, note, driver, now, id)
    } else {
      db.prepare(
        `INSERT INTO connections (id, name, driver, path, read_only, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, name, driver, path, readOnly ? 1 : 0, note, now, now)
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
