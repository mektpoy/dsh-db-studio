/**
 * The model-facing `db` tool.
 *
 * It shares {@link Studio} with the panel, so a query the model runs and a query
 * the user runs follow the same read-only rules and the same row ceiling.
 */

import { describeVerdict, inspectScript } from './sql.js'

const MAX_INLINE_CHARS = 20000

/** Resolve a connection by id or by name, so the model can say `connection: "blog"`. */
function resolve(studio, reference) {
  if (!reference) {
    const all = studio.listConnections()
    if (all.length === 1) return all[0]
    if (all.length === 0) throw new Error('no database connection is saved; add one with action add_connection')
    throw new Error(`several connections are saved (${all.map(item => item.name).join(', ')}); pass connection`)
  }
  const byId = studio.listConnections().find(item => item.id === reference)
  if (byId) return byId
  const byName = studio.listConnections().find(item => item.name === reference)
  if (byName) return byName
  const loose = studio.listConnections().find(
    item => item.name.toLowerCase() === String(reference).toLowerCase(),
  )
  if (loose) return loose
  throw new Error(`no connection matches ${reference}`)
}

/** Trim a long text result so one tool call cannot fill the context window. */
function bounded(text) {
  if (text.length <= MAX_INLINE_CHARS) return text
  return text.slice(0, MAX_INLINE_CHARS)
    + `\n... truncated: ${text.length - MAX_INLINE_CHARS} more characters. Use a smaller limit or export from the panel.`
}

/**
 * @param {import('./studio.js').Studio} studio
 */
export function dbTool(studio) {
  return {
    name: 'db',
    description:
      'Work with SQLite databases through the saved connections of the DB Studio panel. '
      + 'Actions: connections (list saved connections and whether each is read-only); '
      + 'add_connection / remove_connection (edit that list); test (open one and report version and file size); '
      + 'schema (tables and views with row counts, or one object\'s columns, indexes, foreign keys and DDL when you pass table); '
      + 'preview (one page of table rows, oldest columns first); '
      + 'query (run SQL and return columns plus rows); explain (EXPLAIN QUERY PLAN for one statement); '
      + 'export (CSV or JSON text for a read statement or a table); history (recent statements with timing and errors). '
      + 'Read-only is enforced before execution: a saved read-only connection refuses anything that is not a read statement, '
      + 'and a write statement needs allowWrite=true. An unrecognised statement counts as a write. '
      + 'Results stop at limit rows (default 50, at most 500) and say so when more exist.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'connections', 'add_connection', 'remove_connection', 'test',
            'schema', 'preview', 'query', 'explain', 'export', 'history',
          ],
          description: 'Operation to run.',
        },
        connection: {
          type: 'string',
          description: 'Saved connection id or name. Optional when exactly one connection is saved.',
        },
        table: {
          type: 'string',
          description: 'Table or view name for schema, preview and export. For schema, leaving it out lists every object.',
        },
        sql: {
          type: 'string',
          description: 'SQL text for query and explain, or for an export that should read a statement.',
        },
        limit: {
          type: 'integer',
          description: 'preview and query: maximum rows to return (default 50, at most 500).',
        },
        offset: {
          type: 'integer',
          description: 'preview: rows to skip (default 0).',
        },
        order: {
          type: 'string',
          description: 'preview: column to sort by. Defaults to the table\'s natural order.',
        },
        dir: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'preview: sort direction for order (default asc).',
        },
        format: {
          type: 'string',
          enum: ['csv', 'json'],
          description: 'export: output format (default csv).',
        },
        allowWrite: {
          type: 'boolean',
          description: 'query: allow a statement that changes the database. Requires a connection saved with write access.',
        },
        path: {
          type: 'string',
          description: 'add_connection: absolute path of the SQLite file.',
        },
        name: {
          type: 'string',
          description: 'add_connection: display name for the connection.',
        },
        readOnly: {
          type: 'boolean',
          description: 'add_connection: open the file read-only (default true).',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        return [{ type: 'text', text: bounded(text ?? '') }]
      },
    },
    async execute(args) {
      const action = String(args.action)
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500)

      if (action === 'connections') {
        return {
          connections: studio.listConnections().map(item => ({
            id: item.id, name: item.name, path: item.path, readOnly: item.readOnly, note: item.note,
          })),
        }
      }

      if (action === 'add_connection') {
        const saved = studio.saveConnection({
          name: args.name || String(args.path || '').split(/[\\/]/).pop() || 'database',
          path: args.path,
          readOnly: args.readOnly !== false,
        })
        const connection = studio.listConnections().find(item => item.id === saved.id)
        let tested = null
        try { tested = studio.test(saved.id) } catch (error) { tested = { ok: false, error: error.message } }
        return { saved: connection, test: tested }
      }

      const connection = resolve(studio, args.connection)

      if (action === 'remove_connection') {
        return { removed: studio.deleteConnection(connection.id), name: connection.name }
      }

      if (action === 'test') {
        return { connection: connection.name, ...studio.test(connection.id) }
      }

      if (action === 'schema') {
        const result = studio.schema(connection.id, args.table)
        if (result.detail) {
          return {
            connection: connection.name,
            table: result.detail.name,
            type: result.detail.type,
            rows: result.detail.rows,
            columns: result.detail.columns,
            indexes: result.detail.indexes,
            foreignKeys: result.detail.foreignKeys,
            ddl: result.detail.ddl,
          }
        }
        return {
          connection: connection.name,
          readOnly: connection.readOnly,
          stats: result.stats,
          objects: result.objects.slice(0, 300),
          objectCount: result.objects.length,
        }
      }

      if (action === 'preview') {
        if (!args.table) throw new Error('preview needs table')
        const page = studio.preview(connection.id, args.table, {
          limit, offset: Number(args.offset) || 0, orderBy: args.order, dir: args.dir,
        })
        return {
          connection: connection.name,
          table: page.table,
          columns: page.columns.map(column => ({ name: column.name, type: column.type })),
          rows: page.rows,
          returned: page.rows.length,
          total: page.total,
          offset: page.offset,
          hasMore: page.hasMore,
        }
      }

      if (action === 'query') {
        if (!args.sql) throw new Error('query needs sql')
        const script = inspectScript(String(args.sql))
        if (script.hasWrite && connection.readOnly) {
          const index = script.verdicts.findIndex(verdict => verdict !== 'read')
          throw new Error(
            `${connection.name} is read-only, so statement ${index + 1} cannot run (${describeVerdict(script.verdicts[index])})`,
          )
        }
        if (script.hasWrite && args.allowWrite !== true) {
          throw new Error(`statement changes the database; pass allowWrite=true to run it on ${connection.name}`)
        }
        const result = studio.query(connection.id, String(args.sql), {
          maxRows: limit, allowWrite: args.allowWrite === true,
        })
        return {
          connection: connection.name,
          durationMs: result.durationMs,
          changes: result.changes,
          statements: result.statements.map(part => ({
            statement: part.statement,
            columns: part.columns.map(column => column.name),
            rows: part.rows,
            rowCount: part.rowCount,
            truncated: part.truncated,
            changes: part.changes,
          })),
        }
      }

      if (action === 'explain') {
        if (!args.sql) throw new Error('explain needs sql')
        const plan = studio.explain(connection.id, String(args.sql))
        return {
          connection: connection.name,
          columns: plan.columns.map(column => column.name),
          rows: plan.rows,
        }
      }

      if (action === 'export') {
        const file = studio.exportData(connection.id, {
          sql: args.sql, table: args.table, format: args.format, maxRows: limit,
        })
        return {
          connection: connection.name, format: args.format === 'json' ? 'json' : 'csv',
          rows: file.rows, text: file.body,
        }
      }

      if (action === 'history') {
        return { connection: connection.name, history: studio.history(connection.id, limit) }
      }

      throw new Error(`unknown action ${action}`)
    },
  }
}
