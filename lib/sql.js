/**
 * Pure SQL helpers: statement splitting, read/write classification, identifier
 * quoting, and CSV / JSON value encoding.
 *
 * Nothing here touches a database, so the rules that decide whether a statement
 * may run are unit-testable without opening a connection.
 */

/** Statement verbs that change the database. Anything unrecognised is treated as a write. */
const WRITE_HEADS = new Set([
  'insert', 'update', 'delete', 'replace', 'create', 'drop', 'alter',
  'vacuum', 'reindex', 'attach', 'detach',
  'begin', 'commit', 'end', 'rollback', 'savepoint', 'release',
])

/** Statement verbs that only read. */
const READ_HEADS = new Set(['select', 'explain', 'values'])

/**
 * Scan a SQL string and return the statements it contains, split on
 * semicolons that appear outside string literals and comments.
 *
 * @param {string} sql
 * @returns {string[]} statement texts with surrounding whitespace removed; empty
 *   statements (for example the trailing one after a final semicolon) are dropped.
 */
export function splitStatements(sql) {
  const text = typeof sql === 'string' ? sql : ''
  const out = []
  let start = 0
  let i = 0
  // mode is one of: code | single | double | backtick | bracket | line | block
  let mode = 'code'
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (mode === 'code') {
      if (ch === "'") mode = 'single'
      else if (ch === '"') mode = 'double'
      else if (ch === '`') mode = 'backtick'
      else if (ch === '[') mode = 'bracket'
      else if (ch === '-' && next === '-') { mode = 'line'; i += 1 }
      else if (ch === '/' && next === '*') { mode = 'block'; i += 1 }
      else if (ch === ';') {
        out.push(text.slice(start, i))
        start = i + 1
      }
    } else if (mode === 'single') {
      // A doubled quote is an escaped quote, not the end of the literal.
      if (ch === "'") { if (next === "'") i += 1; else mode = 'code' }
    } else if (mode === 'double') {
      if (ch === '"') { if (next === '"') i += 1; else mode = 'code' }
    } else if (mode === 'backtick') {
      if (ch === '`') { if (next === '`') i += 1; else mode = 'code' }
    } else if (mode === 'bracket') {
      if (ch === ']') mode = 'code'
    } else if (mode === 'line') {
      if (ch === '\n') mode = 'code'
    } else if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'block-end'; i += 1 }
    } else if (mode === 'block-end') {
      mode = 'code'
    }
    i += 1
  }
  out.push(text.slice(start))
  return out.map(part => part.trim()).filter(part => part.length > 0)
}

/**
 * Remove comments and string literal contents so keyword detection cannot be
 * fooled by text inside them.
 *
 * @param {string} sql
 * @returns {string} lowercased SQL with literals replaced by empty quotes.
 */
function skeleton(sql) {
  let out = ''
  let i = 0
  const text = String(sql || '')
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '-' && next === '-') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += ' '
    } else if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      out += ' '
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < text.length) {
        if (text[i] === quote) {
          if (text[i + 1] === quote) { i += 2; continue }
          i += 1
          break
        }
        i += 1
      }
      out += "''"
    } else {
      out += ch
      i += 1
    }
  }
  return out.toLowerCase()
}

/**
 * Find the main verb of a `WITH` statement: the first data verb that appears
 * outside parentheses. CTE bodies are parenthesised, so their verbs are skipped;
 * `WITH x AS (SELECT 1) DELETE FROM t` is a write.
 *
 * @param {string} body lowercased SQL with literals removed
 * @returns {string | null}
 */
function verbAfterWith(body) {
  const DATA_VERBS = new Set(['select', 'insert', 'update', 'delete', 'replace', 'values'])
  let depth = 0
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch === '(') { depth += 1; i += 1; continue }
    if (ch === ')') { depth = Math.max(0, depth - 1); i += 1; continue }
    if (depth === 0 && /[a-z_]/.test(ch)) {
      let end = i
      while (end < body.length && /[a-z_]/.test(body[end])) end += 1
      const word = body.slice(i, end)
      if (DATA_VERBS.has(word)) return word
      i = end
      continue
    }
    i += 1
  }
  return null
}

/**
 * Classify one statement as `read`, `write`, or `unknown`.
 *
 * `unknown` means the leading verb is not recognised by this classifier; callers
 * must treat it as a write, because guessing wrong in that direction only costs a
 * rejected query.
 *
 * @param {string} sql one statement
 * @returns {'read' | 'write' | 'unknown'}
 */
export function classifyStatement(sql) {
  const body = skeleton(sql).trim()
  if (!body) return 'unknown'
  const first = /^[a-z_]+/.exec(body)?.[0] || ''
  if (first === 'with') {
    const verb = verbAfterWith(body)
    if (!verb) return 'unknown'
    return verb === 'select' || verb === 'values' ? 'read' : 'write'
  }
  // EXPLAIN without ANALYZE plans the statement instead of running it.
  if (first === 'explain') return 'read'
  if (first === 'pragma') {
    // `PRAGMA table_info(x)` reads; `PRAGMA journal_mode = wal` writes.
    return body.includes('=') ? 'write' : 'read'
  }
  if (READ_HEADS.has(first)) return 'read'
  if (WRITE_HEADS.has(first)) return 'write'
  return 'unknown'
}

/**
 * Classify every statement in a script.
 *
 * @param {string} sql
 * @returns {{ statements: string[], verdicts: Array<'read' | 'write' | 'unknown'>, hasWrite: boolean }}
 */
export function inspectScript(sql) {
  const statements = splitStatements(sql)
  const verdicts = statements.map(classifyStatement)
  return { statements, verdicts, hasWrite: verdicts.some(v => v !== 'read') }
}

/**
 * Quote an identifier for interpolation. Values are always bound as parameters;
 * this is only used for names SQLite cannot bind (table, column, index names).
 *
 * @param {string} name
 * @returns {string} the name wrapped in double quotes with embedded quotes doubled.
 */
export function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"'
}

/**
 * Encode one cell for JSON transport.
 *
 * SQLite returns BLOBs as `Uint8Array`. `JSON.stringify` turns those into
 * `{"0":1,...}`, which is useless to a caller, so blobs become an explicit
 * object the client and the agent tool can both read.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function encodeCell(value) {
  if (value === undefined || value === null) return null
  if (value instanceof Uint8Array) {
    return { $blob: true, size: value.byteLength, base64: Buffer.from(value).toString('base64') }
  }
  if (typeof value === 'bigint') {
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value.toString()
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (value instanceof Date) return value.toISOString()
  return value
}

/** @param {unknown} cell encoded cell */
function csvCell(cell) {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'object' && cell && cell.$blob) return cell.base64
  const text = String(cell)
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
}

/**
 * Render a result set as RFC 4180 CSV.
 *
 * @param {string[]} columns
 * @param {unknown[][]} rows cells already passed through {@link encodeCell}
 * @param {{ bom?: boolean }} [options] `bom` prepends the UTF-8 byte order mark so
 *   spreadsheet software opens non-ASCII text without mangling it.
 * @returns {string}
 */
export function toCsv(columns, rows, options = {}) {
  const lines = [columns.map(csvCell).join(',')]
  for (const row of rows) lines.push(row.map(csvCell).join(','))
  const body = lines.join('\r\n') + '\r\n'
  return options.bom === false ? body : '\uFEFF' + body
}

/**
 * Render a result set as indented JSON.
 *
 * @param {string[]} columns
 * @param {unknown[][]} rows
 * @returns {string}
 */
export function toJson(columns, rows) {
  const objects = rows.map(row => {
    const item = {}
    columns.forEach((column, index) => { item[column] = row[index] ?? null })
    return item
  })
  return JSON.stringify(objects, null, 2)
}

/**
 * Turn an authorizer-free allowlist check into a readable reason.
 *
 * @param {'read' | 'write' | 'unknown'} verdict
 * @returns {string}
 */
export function describeVerdict(verdict) {
  if (verdict === 'read') return 'read statement'
  if (verdict === 'write') return 'statement changes the database'
  return 'statement type not recognised'
}
