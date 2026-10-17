import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteDriver, sqliteStatus } from '../lib/sqlite-driver.js'
import { Studio } from '../lib/studio.js'
import { StudioStore } from '../lib/store.js'

const available = sqliteStatus().available
const skip = available ? false : 'this runtime has no node:sqlite'

/** In-memory stand-in for the Harness credential store. */
function memorySecrets() {
  const values = new Map()
  return {
    values,
    async get(id) { return values.get(id) },
    async set(id, value) { values.set(id, value) },
    async clear(id) { values.delete(id) },
  }
}

/** A temp directory holding one database file plus the plugin store. */
async function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'db-studio-service-'))
  const databasePath = join(directory, 'app.db')
  const writer = new SqliteDriver({ path: databasePath, readOnly: false })
  await writer.open()
  await writer.run(`
    CREATE TABLE item (id INTEGER PRIMARY KEY, label TEXT NOT NULL, price REAL);
    INSERT INTO item (label, price) VALUES ('pen', 1.5), ('ink', 8), ('paper, white', 3.25);
  `, { allowWrite: true })
  await writer.close()
  const store = new StudioStore(join(directory, 'state'))
  const studio = new Studio({ store })
  return { directory, databasePath, store, studio }
}

test('a saved connection defaults to read-only', { skip }, async () => {
  const { directory, databasePath, store, studio } = await workspace()
  try {
    const { id } = await studio.saveConnection({ name: 'app', path: databasePath })
    const connection = studio.listConnections().find(item => item.id === id)
    assert.equal(connection.readOnly, true)
    await assert.rejects(
      () => studio.query(id, "insert into item (label) values ('x')", { allowWrite: true }),
      /read-only/,
    )
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('allowWriteByDefault opens new connections for writing', { skip }, async () => {
  const { directory, databasePath, store } = await workspace()
  try {
    const studio = new Studio({ store, defaultReadOnly: false })
    const { id } = await studio.saveConnection({ name: 'app', path: databasePath })
    assert.equal(studio.listConnections().find(item => item.id === id).readOnly, false)
    await studio.query(id, "insert into item (label) values ('chalk')", { allowWrite: true })
    const rows = (await studio.query(id, 'select count(*) as n from item')).statements[0].rows
    assert.equal(rows[0][0], 4)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a writable connection still needs allowWrite for a change', { skip }, async () => {
  const { directory, databasePath, store } = await workspace()
  try {
    const studio = new Studio({ store, defaultReadOnly: false })
    const { id } = await studio.saveConnection({ name: 'app', path: databasePath })
    await assert.rejects(() => studio.query(id, 'delete from item where id = 1'), /allowWrite/)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('export renders a table as CSV', { skip }, async () => {
  const { directory, databasePath, store, studio } = await workspace()
  try {
    const { id } = await studio.saveConnection({ name: 'app', path: databasePath })
    const file = await studio.exportData(id, { table: 'item', format: 'csv' })
    assert.equal(file.rows, 3)
    assert.match(file.filename, /^app-item-.*\.csv$/)
    const lines = file.body.replace(/^\uFEFF/, '').trimEnd().split('\r\n')
    assert.deepEqual(lines[0].split(','), ['id', 'label', 'price'])
    assert.equal(lines[1], '1,pen,1.5')
    // A comma inside a value must be quoted.
    assert.equal(lines[3], '3,"paper, white",3.25')
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('export renders a statement as JSON', { skip }, async () => {
  const { directory, databasePath, store, studio } = await workspace()
  try {
    const { id } = await studio.saveConnection({ name: 'app', path: databasePath })
    const file = await studio.exportData(id, {
      sql: 'select id, label from item order by id desc limit 2', format: 'json',
    })
    assert.deepEqual(JSON.parse(file.body), [{ id: 3, label: 'paper, white' }, { id: 2, label: 'ink' }])
    assert.match(file.filename, /\.json$/)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('export refuses a statement that writes', { skip }, async () => {
  const { directory, databasePath, store, studio } = await workspace()
  try {
    const { id } = await studio.saveConnection({ name: 'app', path: databasePath })
    await assert.rejects(
      () => studio.exportData(id, { sql: 'delete from item', format: 'csv' }),
      /read statements only/,
    )
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('query history records both outcomes with timing', { skip }, async () => {
  const { directory, databasePath, store, studio } = await workspace()
  try {
    const { id } = await studio.saveConnection({ name: 'app', path: databasePath })
    await studio.query(id, 'select 1')
    await assert.rejects(() => studio.query(id, 'select * from missing_table'))
    const history = studio.history(id, 10)
    assert.equal(history.length, 2)
    assert.equal(history[0].ok, false)
    assert.match(history[0].error, /missing_table/)
    assert.equal(history[1].ok, true)
    assert.equal(history[1].rowCount, 1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('history is bounded and can be cleared', { skip }, async () => {
  const { directory, databasePath, store, studio } = await workspace()
  try {
    const { id } = await studio.saveConnection({ name: 'app', path: databasePath })
    for (let index = 0; index < 12; index += 1) await studio.query(id, `select ${index}`)
    assert.equal(studio.history(id, 20).length, 12)
    studio.clearHistory(id)
    assert.equal(studio.history(id, 20).length, 0)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('deleting a connection removes its history', { skip }, async () => {
  const { directory, databasePath, store, studio } = await workspace()
  try {
    const { id } = await studio.saveConnection({ name: 'app', path: databasePath })
    await studio.query(id, 'select 1')
    assert.equal(await studio.deleteConnection(id), true)
    assert.equal(studio.listConnections().length, 0)
    assert.equal(studio.history(id, 10).length, 0)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an unknown connection id fails with a readable message', { skip }, async () => {
  const { directory, store, studio } = await workspace()
  try {
    await assert.rejects(() => studio.schema('nope'), /no saved connection with id nope/)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a PostgreSQL connection stores its address and keeps the password out of the row', { skip }, async () => {
  const { directory, store } = await workspace()
  const secrets = memorySecrets()
  const studio = new Studio({ store, secrets })
  try {
    const { id } = await studio.saveConnection({
      name: 'pg',
      driver: 'postgres',
      host: 'db.internal',
      port: 6432,
      dbname: 'analytics',
      username: 'reader',
      password: 's3cret',
      readOnly: true,
    })
    const connection = studio.listConnections().find(item => item.id === id)
    assert.equal(connection.driver, 'postgres')
    assert.equal(connection.host, 'db.internal')
    assert.equal(connection.port, 6432)
    assert.equal(connection.dbname, 'analytics')
    assert.equal(connection.username, 'reader')
    assert.equal(connection.path, '')
    // The secret lives in the secret store, keyed by the connection id.
    assert.equal(secrets.values.get(id), 's3cret')
    assert.equal(Object.values(connection).includes('s3cret'), false)
    await studio.deleteConnection(id)
    assert.equal(secrets.values.has(id), false)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a PostgreSQL connection needs a host and a database name', { skip }, async () => {
  const { directory, store } = await workspace()
  try {
    const studio = new Studio({ store })
    await assert.rejects(
      () => studio.saveConnection({ name: 'pg', driver: 'postgres', host: 'db.internal' }),
      /host and a database name/,
    )
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a stored file from the first release gains the new columns', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'db-studio-migrate-'))
  try {
    // Write the original four-column shape, then let the store migrate it.
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(join(directory, 'studio.db'))
    raw.exec(`CREATE TABLE connections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, driver TEXT NOT NULL DEFAULT 'sqlite',
      path TEXT NOT NULL, read_only INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    raw.prepare('INSERT INTO connections VALUES (?,?,?,?,?,?,?,?)')
      .run('old-id', 'legacy', 'sqlite', 'C:/tmp/legacy.db', 1, '', Date.now(), Date.now())
    raw.close()

    const store = new StudioStore(directory)
    const connection = store.getConnection('old-id')
    store.close()
    assert.equal(connection.name, 'legacy')
    assert.equal(connection.driver, 'sqlite')
    assert.equal(connection.host, '')
    assert.equal(connection.port, 5432)
    assert.equal(connection.readOnly, true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
