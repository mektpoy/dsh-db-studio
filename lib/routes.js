/**
 * HTTP surface for the panel.
 *
 * Two routes only: `GET .../state` for everything the panel draws on first paint,
 * and `POST .../action` for every operation. Both are served by {@link Studio},
 * the same service the `db` tool uses.
 */

const API = '/db-studio/api'
const MAX_BODY_BYTES = 1024 * 1024

/** Read and parse a JSON request body, rejecting anything that is not JSON. */
function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers?.['content-type'] || '')
    if (!type.includes('application/json')) {
      reject(Object.assign(new Error('request body must be application/json'), { status: 415 }))
      return
    }
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('request body is too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) { resolve({}); return }
      try {
        const value = JSON.parse(text)
        resolve(value && typeof value === 'object' ? value : {})
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { status: 400 }))
      }
    })
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

const numberOrUndefined = value => (value === undefined || value === null || value === '' ? undefined : Number(value))

/**
 * @param {{ webServer: { register: (route: object) => () => void } }} ctx
 * @param {{ studio: import('./studio.js').Studio, sqliteStatus: () => { available: boolean, reason?: string }, version: string }} services
 */
export function registerRoutes(ctx, services) {
  const { studio, sqliteStatus, version } = services

  const state = () => ({
    version,
    sqlite: sqliteStatus(),
    connections: studio.listConnections(),
    history: studio.history('', 20),
  })

  /** Dispatch one panel action. Unknown actions fail loudly rather than silently. */
  async function dispatch(action, body) {
    switch (action) {
      case 'state':
        return state()
      case 'save':
        return studio.saveConnection({
          id: body.id,
          name: body.name,
          driver: body.driver,
          path: body.path,
          host: body.host,
          port: body.port,
          dbname: body.database,
          username: body.username,
          password: body.password,
          ssl: body.ssl === true,
          readOnly: body.readOnly,
          note: body.note,
        })
      case 'delete':
        return { removed: await studio.deleteConnection(String(body.id || '')) }
      case 'test': {
        const connection = studio.requireConnection(String(body.id || ''))
        return { connection: connection.name, ...await studio.test(connection.id) }
      }
      case 'schema':
        return studio.schema(String(body.id || ''), body.table ? String(body.table) : undefined)
      case 'preview':
        return studio.preview(String(body.id || ''), String(body.table || ''), {
          limit: numberOrUndefined(body.limit),
          offset: numberOrUndefined(body.offset),
          orderBy: body.order ? String(body.order) : undefined,
          dir: body.dir ? String(body.dir) : undefined,
          search: body.search ? String(body.search) : undefined,
          filters: body.filters && typeof body.filters === 'object' ? body.filters : undefined,
        })
      case 'query':
        return studio.query(String(body.id || ''), String(body.sql || ''), {
          maxRows: numberOrUndefined(body.maxRows),
          allowWrite: body.allowWrite === true,
        })
      case 'explain':
        return studio.explain(String(body.id || ''), String(body.sql || ''))
      case 'export':
        return studio.exportData(String(body.id || ''), {
          sql: body.sql ? String(body.sql) : undefined,
          table: body.table ? String(body.table) : undefined,
          format: body.format === 'json' ? 'json' : 'csv',
          maxRows: numberOrUndefined(body.maxRows),
        })
      case 'history':
        return { history: studio.history(body.id ? String(body.id) : '', numberOrUndefined(body.limit)) }
      case 'clear_history':
        studio.clearHistory(body.id ? String(body.id) : '')
        return { cleared: true }
      default:
        throw Object.assign(new Error(`unknown action ${action}`), { status: 400 })
    }
  }

  return [
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/state`,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'use GET' })
          return
        }
        try {
          sendJson(res, 200, { ok: true, data: state() })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error?.message || String(error) })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/action`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use POST' })
          return
        }
        let body
        try {
          body = await readJson(req)
        } catch (error) {
          sendJson(res, error.status || 400, { ok: false, error: error.message })
          return
        }
        const action = String(body.action || '')
        if (!action) {
          sendJson(res, 400, { ok: false, error: 'action is required' })
          return
        }
        try {
          const data = await dispatch(action, body)
          sendJson(res, 200, { ok: true, data })
        } catch (error) {
          sendJson(res, error?.status === 415 || error?.status === 413 ? error.status : 400, {
            ok: false, error: error?.message || String(error),
          })
        }
      },
    }),
  ]
}
