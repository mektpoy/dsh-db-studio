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

/** A temp directory holding one database file plus the plugin store. */
function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'db-studio-service-'))
  const databasePath = join(directory, 'app.db')
  const writer = new SqliteDriver({ path: databasePath, readOnly: false })
  writer.open()
  writer.run(`
    CREATE TABLE item (id INTEGER PRIMARY KEY, label TEXT NOT NULL, price REAL);
    INSERT INTO item (label, price) VALUES ('pen', 1.5), ('ink', 8), ('paper, white', 3.25);
  `, { allowWrite: true })
  writer.close()
  const store = new StudioStore(join(directory, 'state'))
  const studio = new Studio({ store })
  return { directory, databasePath, store, studio }
}

test('a saved connection defaults to read-only', { skip }, () => {
  const { directory, databasePath, store, studio } = workspace()
  try {
    const { id } = studio.saveConnection({ name: 'app', path: databasePath })
    const connection = studio.listConnections().find(item => item.id === id)
    assert.equal(connection.readOnly, true)
    assert.throws(() => studio.query(id, "insert into item (label) values ('x')", { allowWrite: true }), /read-only/)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('allowWriteByDefault opens new connections for writing', { skip }, () => {
  const { directory, databasePath, store } = workspace()
  try {
    const studio = new Studio({ store, defaultReadOnly: false })
    const { id } = studio.saveConnection({ name: 'app', path: databasePath })
    assert.equal(studio.listConnections().find(item => item.id === id).readOnly, false)
    studio.query(id, "insert into item (label) values ('chalk')", { allowWrite: true })
    const rows = studio.query(id, 'select count(*) as n from item').statements[0].rows
    assert.equal(rows[0][0], 4)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a writable connection still needs allowWrite for a change', { skip }, () => {
  const { directory, databasePath, store } = workspace()
  try {
    const studio = new Studio({ store, defaultReadOnly: false })
    const { id } = studio.saveConnection({ name: 'app', path: databasePath })
    assert.throws(() => studio.query(id, "delete from item where id = 1"), /allowWrite/)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('export renders a table as CSV', { skip }, () => {
  const { directory, databasePath, store, studio } = workspace()
  try {
    const { id } = studio.saveConnection({ name: 'app', path: databasePath })
    const file = studio.exportData(id, { table: 'item', format: 'csv' })
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

test('export renders a statement as JSON', { skip }, () => {
  const { directory, databasePath, store, studio } = workspace()
  try {
    const { id } = studio.saveConnection({ name: 'app', path: databasePath })
    const file = studio.exportData(id, {
      sql: 'select id, label from item order by id desc limit 2', format: 'json',
    })
    assert.deepEqual(JSON.parse(file.body), [{ id: 3, label: 'paper, white' }, { id: 2, label: 'ink' }])
    assert.match(file.filename, /\.json$/)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('export refuses a statement that writes', { skip }, () => {
  const { directory, databasePath, store, studio } = workspace()
  try {
    const { id } = studio.saveConnection({ name: 'app', path: databasePath })
    assert.throws(() => studio.exportData(id, { sql: "delete from item", format: 'csv' }), /read statements only/)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('query history records both outcomes with timing', { skip }, () => {
  const { directory, databasePath, store, studio } = workspace()
  try {
    const { id } = studio.saveConnection({ name: 'app', path: databasePath })
    studio.query(id, 'select 1')
    assert.throws(() => studio.query(id, 'select * from missing_table'))
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

test('history is bounded and can be cleared', { skip }, () => {
  const { directory, databasePath, store, studio } = workspace()
  try {
    const { id } = studio.saveConnection({ name: 'app', path: databasePath })
    for (let index = 0; index < 12; index += 1) studio.query(id, `select ${index}`)
    assert.equal(studio.history(id, 20).length, 12)
    studio.clearHistory(id)
    assert.equal(studio.history(id, 20).length, 0)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('deleting a connection removes its history', { skip }, () => {
  const { directory, databasePath, store, studio } = workspace()
  try {
    const { id } = studio.saveConnection({ name: 'app', path: databasePath })
    studio.query(id, 'select 1')
    assert.equal(studio.deleteConnection(id), true)
    assert.equal(studio.listConnections().length, 0)
    assert.equal(studio.history(id, 10).length, 0)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an unknown connection id fails with a readable message', { skip }, () => {
  const { directory, store, studio } = workspace()
  try {
    assert.throws(() => studio.schema('nope'), /no saved connection with id nope/)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
