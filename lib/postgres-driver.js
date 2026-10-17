/**
 * PostgreSQL driver over the `pg` package.
 *
 * It implements the same contract as {@link SqliteDriver}: objects, describe,
 * preview, run, explain, stats. The differences that matter are schemas (every
 * object is addressed as `schema.table`), approximate row counts from
 * `pg_class.reltuples`, and a server-side read-only transaction default so a
 * missed classifier rule cannot change data on a read-only connection.
 */

import pg from 'pg'
import { classifyStatement, encodeCell, inspectScript, quoteIdent, splitStatements } from './sql.js'

const { Client } = pg

/** Rows a count may scan before the driver reports "at least this many". */
const COUNT_CAP = 100000

/** Result column type ids to names, for the grid header only. */
const TYPE_NAMES = {
  16: 'bool',
  17: 'bytea',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  114: 'json',
  700: 'float4',
  701: 'float8',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamptz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
}

/** `schema.table`, with `public` left implicit because that is the usual case. */
function displayName(schema, table) {
  return schema && schema !== 'public' ? `${schema}.${table}` : table
}

/** Split `a.b` or `a` into schema and table; a bare name means `public`. */
function parseName(name) {
  const text = String(name || '').trim()
  const dot = text.indexOf('.')
  if (dot === -1) return { schema: 'public', table: text }
  return { schema: text.slice(0, dot), table: text.slice(dot + 1) }
}

function qualified(schema, table) {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`
}

/** Columns of a result set, with type names where pg knows the OID. */
function columnsOf(result) {
  return (result.fields || []).map(field => ({
    name: field.name,
    type: TYPE_NAMES[field.dataTypeID] || String(field.dataTypeID),
    table: '',
  }))
}

/** pg hands back Date and Buffer values; both need explicit transport shapes. */
function encodeRow(row, columns) {
  return columns.map(column => encodeCell(row[column.name]))
}

export class PostgresDriver {
  /** @type {'postgres'} */
  kind = 'postgres'

  /**
   * @param {{ host: string, port: number, dbname: string, username: string, password?: string,
   *   ssl?: boolean, readOnly?: boolean }} connection
   */
  constructor(connection) {
    this.connection = connection
    this.client = null
  }

  async open() {
    if (this.client) return this.client
    const connection = this.connection
    if (!connection.host) throw new Error('a PostgreSQL connection needs a host')
    if (!connection.dbname) throw new Error('a PostgreSQL connection needs a database name')
    const client = new Client({
      host: connection.host,
      port: Number(connection.port) || 5432,
      database: connection.dbname,
      user: connection.username || undefined,
      password: connection.password || undefined,
      ssl: connection.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 8000,
      query_timeout: 30000,
      statement_timeout: 30000,
      application_name: 'dsh-db-studio',
    })
    // A connection error after connect must not crash the Host.
    client.on('error', () => { /* reported by the operation that hit it */ })
    try {
      await client.connect()
    } catch (error) {
      const message = error?.message || String(error)
      if (/password must be a string|password authentication failed/i.test(message)) {
        throw new Error(
          'this connection has no usable password: edit it and enter the password. '
          + `Passwords live in the Harness credential store, not in the plugin database. Server said: ${message}`,
        )
      }
      throw error
    }
    if (connection.readOnly) {
      // The classifier already refuses writes; this makes the server refuse too.
      await client.query('SET default_transaction_read_only = on')
    }
    this.client = client
    return client
  }

  async close() {
    if (!this.client) return
    const client = this.client
    this.client = null
    try { await client.end() } catch { /* already gone */ }
  }

  async test() {
    const client = await this.open()
    const info = await client.query(
      `SELECT version() AS version, current_database() AS db,
              pg_size_pretty(pg_database_size(current_database())) AS size,
              pg_database_size(current_database()) AS bytes`,
    )
    const row = info.rows[0] || {}
    return {
      ok: true,
      version: String(row.version || '').split(' ').slice(0, 2).join(' '),
      bytes: Number(row.bytes) || 0,
      size: row.size || '',
      database: row.db || this.connection.dbname,
      host: `${this.connection.host}:${Number(this.connection.port) || 5432}`,
      readOnly: this.connection.readOnly === true,
    }
  }

  async objects(options = {}) {
    const client = await this.open()
    const listed = await client.query(
      `SELECT n.nspname AS schema, c.relname AS name,
              CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' ELSE 'table' END AS type,
              c.reltuples::bigint AS estimate
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg_toast%'
       ORDER BY n.nspname, c.relname`,
    )
    const rows = []
    for (const item of listed.rows) {
      const entry = {
        name: displayName(item.schema, item.name),
        schema: item.schema,
        table: item.name,
        type: item.type,
        // reltuples is an estimate maintained by ANALYZE; report it as such
        // rather than paying for a COUNT on every table in the tree.
        rows: Math.max(0, Number(item.estimate) || 0),
        rowsEstimated: true,
        rowsCapped: false,
      }
      if (options.withCounts === true && item.type === 'table') {
        try {
          const counted = await client.query(
            `SELECT count(*) AS n FROM (SELECT 1 FROM ${qualified(item.schema, item.name)} LIMIT ${COUNT_CAP + 1}) s`,
          )
          const value = Number(counted.rows[0].n) || 0
          entry.rows = Math.min(value, COUNT_CAP)
          entry.rowsEstimated = false
          entry.rowsCapped = value > COUNT_CAP
        } catch {
          /* keep the estimate */
        }
      }
      rows.push(entry)
    }
    return rows
  }

  async describe(name) {
    const client = await this.open()
    const { schema, table } = parseName(name)
    const exists = await client.query(
      `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','v','m')`,
      [schema, table],
    )
    if (exists.rowCount === 0) throw new Error(`no table or view named ${name}`)

    const columnRows = await client.query(
      `SELECT column_name, data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, table],
    )
    const primary = await client.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
       ORDER BY kcu.ordinal_position`,
      [schema, table],
    )
    const primaryKeys = new Set(primary.rows.map(row => row.column_name))
    const columns = columnRows.rows.map(row => ({
      name: row.column_name,
      type: row.data_type === 'USER-DEFINED' ? row.udt_name : row.data_type,
      notNull: row.is_nullable === 'NO',
      defaultValue: row.column_default,
      primaryKey: primaryKeys.has(row.column_name),
      primaryKeyOrder: primaryKeys.has(row.column_name)
        ? primary.rows.findIndex(item => item.column_name === row.column_name) + 1
        : 0,
    }))

    const indexRows = await client.query(
      'SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname',
      [schema, table],
    )
    const indexes = indexRows.rows.map(row => ({
      name: row.indexname,
      unique: /\bUNIQUE\b/i.test(row.indexdef),
      origin: 'pg_indexes',
      columns: (/\(([^)]+)\)/.exec(row.indexdef)?.[1] || '')
        .split(',')
        .map(part => part.trim())
        .filter(Boolean),
    }))

    const foreignRows = await client.query(
      `SELECT kcu.column_name AS "from", ccu.table_schema AS ref_schema, ccu.table_name AS ref_table,
              ccu.column_name AS ref_column, rc.delete_rule, tc.constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, table],
    )
    const foreignKeys = foreignRows.rows.map((row, index) => ({
      id: index,
      table: displayName(row.ref_schema, row.ref_table),
      from: row.from,
      to: row.ref_column,
      onUpdate: '',
      onDelete: String(row.delete_rule || '').toLowerCase(),
    }))

    const estimate = await client.query('SELECT reltuples::bigint AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2', [schema, table])
    const rows = Math.max(0, Number(estimate.rows[0]?.n) || 0)

    // PostgreSQL has no SHOW CREATE TABLE, so the statement below is rebuilt from
    // the catalog. It is a description of the table, not the original text.
    const lines = columns.map(column => {
      const parts = [`  ${quoteIdent(column.name)} ${column.type}`]
      if (column.notNull) parts.push('NOT NULL')
      if (column.defaultValue) parts.push(`DEFAULT ${column.defaultValue}`)
      return parts.join(' ')
    })
    if (primaryKeys.size > 0) lines.push(`  PRIMARY KEY (${[...primaryKeys].map(quoteIdent).join(', ')})`)
    for (const key of foreignKeys) {
      lines.push(`  FOREIGN KEY (${quoteIdent(key.from)}) REFERENCES ${key.table} (${quoteIdent(key.to)})`)
    }
    const ddl = [
      `CREATE TABLE ${qualified(schema, table)} (`,
      lines.join(',\n'),
      ');',
      ...indexes.map(index => {
        const def = indexRows.rows.find(row => row.name === index.name)?.indexdef || ''
        return def ? `${def};` : ''
      }).filter(Boolean),
    ].join('\n')

    return {
      name: displayName(schema, table),
      schema,
      table,
      type: exists.rows[0].relkind === 'v' || exists.rows[0].relkind === 'm' ? 'view' : 'table',
      ddl,
      columns,
      indexes,
      foreignKeys,
      rows,
      rowsEstimated: true,
      rowsCapped: false,
    }
  }

  async preview(name, options = {}) {
    const client = await this.open()
    const { schema, table } = parseName(name)
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 1000)
    const offset = Math.max(Number(options.offset) || 0, 0)
    const clauses = []
    const params = []
    const search = String(options.search ?? '').trim()
    const columnRows = await client.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
      [schema, table],
    )
    const names = columnRows.rows.map(row => row.column_name)
    if (search && names.length > 0) {
      clauses.push('(' + names.map(column => `CAST(${quoteIdent(column)} AS text) ILIKE $${params.length + 1}`).join(' OR ') + ')')
      for (let index = 0; index < names.length; index += 1) params.push(`%${search}%`)
    }
    for (const [column, value] of Object.entries(options.filters || {})) {
      if (value === undefined || value === null || value === '') continue
      params.push(`%${String(value)}%`)
      clauses.push(`CAST(${quoteIdent(column)} AS text) ILIKE $${params.length}`)
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    const direction = String(options.dir || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
    const order = options.orderBy ? ` ORDER BY ${quoteIdent(options.orderBy)} ${direction}` : ''
    const page = await client.query(
      `SELECT * FROM ${qualified(schema, table)}${where}${order} LIMIT ${limit + 1} OFFSET ${offset}`,
      params,
    )
    const truncated = page.rows.length > limit
    const kept = truncated ? page.rows.slice(0, limit) : page.rows
    const columns = columnsOf(page)
    let total = null
    let totalCapped = false
    try {
      const counted = await client.query(
        `SELECT count(*) AS n FROM (SELECT 1 FROM ${qualified(schema, table)}${where} LIMIT ${COUNT_CAP + 1}) s`,
        params,
      )
      const value = Number(counted.rows[0].n) || 0
      total = Math.min(value, COUNT_CAP)
      totalCapped = value > COUNT_CAP
    } catch {
      total = null
    }
    return {
      table: displayName(schema, table),
      columns,
      rows: kept.map(row => {
        const encoded = {}
        for (const column of columns) encoded[column.name] = encodeCell(row[column.name])
        return encoded
      }),
      total,
      totalCapped,
      limit,
      offset,
      hasMore: truncated || (total !== null && offset + kept.length < total),
    }
  }

  async run(sql, options = {}) {
    const client = await this.open()
    const started = Date.now()
    const maxRows = Math.min(Math.max(Number(options.maxRows) || 500, 1), 5000)
    const { statements, verdicts, hasWrite } = inspectScript(sql)
    if (statements.length === 0) throw new Error('the statement is empty')
    const readOnly = this.connection.readOnly === true
    if (readOnly && hasWrite) {
      const index = verdicts.findIndex(verdict => verdict !== 'read')
      throw new Error(
        `read-only connection refuses statement ${index + 1} (${classifyStatement(statements[index])}); `
        + 'open the connection with write access to run it',
      )
    }
    if (options.allowWrite !== true && hasWrite) {
      throw new Error('this tool call is not allowed to change the database; pass allowWrite')
    }

    const results = []
    let changes = 0
    const transactional = statements.length > 1 && hasWrite
    if (transactional) await client.query('BEGIN')
    try {
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index]
        const result = await client.query(statement)
        const columns = columnsOf(result)
        const raw = result.rows || []
        const truncated = raw.length > maxRows
        const kept = truncated ? raw.slice(0, maxRows) : raw
        const affected = Number(result.rowCount) || 0
        if (!columns.length) changes += affected
        results.push({
          statement: index + 1,
          sql: statement,
          columns,
          rows: kept.map(row => encodeRow(row, columns)),
          rowCount: raw.length,
          truncated,
          changes: columns.length ? 0 : affected,
        })
      }
      if (transactional) await client.query('COMMIT')
    } catch (error) {
      if (transactional) {
        try { await client.query('ROLLBACK') } catch { /* the transaction may be gone */ }
      }
      throw error
    }
    return { statements: results, changes, durationMs: Date.now() - started, readOnly }
  }

  async explain(sql) {
    const client = await this.open()
    const statements = splitStatements(sql)
    if (statements.length === 0) throw new Error('the statement is empty')
    // Plain EXPLAIN plans the statement; it does not execute it.
    const plan = await client.query(`EXPLAIN (FORMAT TEXT, COSTS TRUE) ${statements[0]}`)
    const columns = columnsOf(plan)
    return {
      columns,
      rows: (plan.rows || []).map(row => columns.map(column => encodeCell(row[column.name]))),
    }
  }

  async stats() {
    const client = await this.open()
    const info = await client.query(
      `SELECT current_database() AS db, version() AS version,
              pg_size_pretty(pg_database_size(current_database())) AS size,
              pg_database_size(current_database()) AS bytes,
              pg_encoding_to_char(encoding) AS encoding
       FROM pg_database WHERE datname = current_database()`,
    )
    const row = info.rows[0] || {}
    const counts = await client.query(
      `SELECT count(*) FILTER (WHERE c.relkind IN ('r','p')) AS tables,
              count(*) FILTER (WHERE c.relkind IN ('v','m')) AS views
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'`,
    )
    return {
      host: this.connection.host,
      port: Number(this.connection.port) || 5432,
      database: row.db,
      version: String(row.version || '').split(' ').slice(0, 2).join(' '),
      encoding: row.encoding,
      bytes: Number(row.bytes) || 0,
      size: row.size,
      tables: Number(counts.rows[0].tables) || 0,
      views: Number(counts.rows[0].views) || 0,
    }
  }
}
