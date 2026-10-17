import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteDriver, sqliteStatus } from '../lib/sqlite-driver.js'
import { Studio } from '../lib/studio.js'
import { StudioStore } from '../lib/store.js'
import { dbTool } from '../lib/tool.js'

const available = sqliteStatus().available
const skip = available ? false : 'this runtime has no node:sqlite'

function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'db-studio-tool-'))
  const databasePath = join(directory, 'shop.db')
  const writer = new SqliteDriver({ path: databasePath, readOnly: false })
  writer.open()
  writer.run(`
    CREATE TABLE product (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL);
    INSERT INTO product (name, price) VALUES ('mug', 4.5), ('lamp', 22), ('desk', 180);
  `, { allowWrite: true })
  writer.close()
  const store = new StudioStore(join(directory, 'state'))
  const studio = new Studio({ store, defaultReadOnly: options.defaultReadOnly !== false })
  const tool = dbTool(studio)
  return { directory, databasePath, store, studio, tool }
}

test('connections lists what is saved', { skip }, async () => {
  const { directory, databasePath, store, tool } = fixture()
  try {
    assert.deepEqual((await tool.execute({ action: 'connections' })).connections, [])
    await tool.execute({ action: 'add_connection', path: databasePath, name: 'shop' })
    const listed = await tool.execute({ action: 'connections' })
    assert.equal(listed.connections.length, 1)
    assert.equal(listed.connections[0].name, 'shop')
    assert.equal(listed.connections[0].readOnly, true)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('add_connection names the connection after the file and reports a test', { skip }, async () => {
  const { directory, databasePath, store, tool } = fixture()
  try {
    const result = await tool.execute({ action: 'add_connection', path: databasePath })
    assert.equal(result.saved.name, 'shop.db')
    assert.equal(result.test.ok, true)
    assert.notEqual(result.test.version, '')
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a connection can be addressed by name', { skip }, async () => {
  const { directory, databasePath, store, tool } = fixture()
  try {
    await tool.execute({ action: 'add_connection', path: databasePath, name: 'shop' })
    const result = await tool.execute({ action: 'schema', connection: 'shop' })
    assert.deepEqual(result.objects.map(object => object.name), ['product'])
    assert.equal(result.objects[0].rows, 3)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('schema with a table returns columns, indexes and DDL', { skip }, async () => {
  const { directory, databasePath, store, tool } = fixture()
  try {
    await tool.execute({ action: 'add_connection', path: databasePath, name: 'shop' })
    const detail = await tool.execute({ action: 'schema', connection: 'shop', table: 'product' })
    assert.equal(detail.table, 'product')
    assert.deepEqual(detail.columns.map(column => column.name), ['id', 'name', 'price'])
    assert.match(detail.ddl, /CREATE TABLE product/)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('preview reports the page, the total and whether more rows exist', { skip }, async () => {
  const { directory, databasePath, store, tool } = fixture()
  try {
    await tool.execute({ action: 'add_connection', path: databasePath, name: 'shop' })
    const page = await tool.execute({ action: 'preview', connection: 'shop', table: 'product', limit: 2 })
    assert.equal(page.returned, 2)
    assert.equal(page.total, 3)
    assert.equal(page.hasMore, true)
    assert.deepEqual(page.rows.map(row => row.name), ['mug', 'lamp'])
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('query returns columns and rows', { skip }, async () => {
  const { directory, databasePath, store, tool } = fixture()
  try {
    await tool.execute({ action: 'add_connection', path: databasePath, name: 'shop' })
    const result = await tool.execute({
      action: 'query', connection: 'shop', sql: 'select name, price from product order by price desc',
    })
    assert.deepEqual(result.statements[0].columns, ['name', 'price'])
    assert.deepEqual(result.statements[0].rows[0], ['desk', 180])
    assert.equal(result.statements[0].rowCount, 3)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a write on a read-only connection is refused before it runs', { skip }, async () => {
  const { directory, databasePath, store, tool } = fixture()
  try {
    await tool.execute({ action: 'add_connection', path: databasePath, name: 'shop' })
    await assert.rejects(
      () => tool.execute({
        action: 'query', connection: 'shop', sql: "delete from product where id = 1", allowWrite: true,
      }),
      /shop is read-only/,
    )
    const count = await tool.execute({ action: 'query', connection: 'shop', sql: 'select count(*) as n from product' })
    assert.equal(count.statements[0].rows[0][0], 3)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a write on a writable connection needs allowWrite', { skip }, async () => {
  const { directory, databasePath, store, tool } = fixture({ defaultReadOnly: false })
  try {
    await tool.execute({ action: 'add_connection', path: databasePath, name: 'shop', readOnly: false })
    await assert.rejects(
      () => tool.execute({ action: 'query', connection: 'shop', sql: "delete from product where id = 1" }),
      /pass allowWrite/,
    )
    const done = await tool.execute({
      action: 'query', connection: 'shop', sql: "delete from product where id = 1", allowWrite: true,
    })
    assert.equal(done.changes, 1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('explain returns plan rows', { skip }, async () => {
  const { directory, databasePath, store, tool } = fixture()
  try {
    await tool.execute({ action: 'add_connection', path: databasePath, name: 'shop' })
    const plan = await tool.execute({ action: 'explain', connection: 'shop', sql: 'select * from product where id = 2' })
    assert.ok(plan.rows.length > 0)
    assert.ok(plan.columns.includes('detail'))
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('export returns text for a table', { skip }, async () => {
  const { directory, databasePath, store, tool } = fixture()
  try {
    await tool.execute({ action: 'add_connection', path: databasePath, name: 'shop' })
    const file = await tool.execute({
      action: 'export', connection: 'shop', table: 'product', format: 'csv', limit: 2,
    })
    assert.equal(file.format, 'csv')
    assert.equal(file.rows, 2)
    // CSV carries a byte order mark so spreadsheet software opens it as UTF-8.
    assert.match(file.text.replace(/^\uFEFF/, ''), /^id,name,price/)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('history lists what ran', { skip }, async () => {
  const { directory, databasePath, store, tool } = fixture()
  try {
    await tool.execute({ action: 'add_connection', path: databasePath, name: 'shop' })
    await tool.execute({ action: 'query', connection: 'shop', sql: 'select 1' })
    const result = await tool.execute({ action: 'history', connection: 'shop' })
    assert.ok(result.history.some(entry => entry.ok && entry.sql === 'select 1'))
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('remove_connection drops the record', { skip }, async () => {
  const { directory, databasePath, store, tool } = fixture()
  try {
    await tool.execute({ action: 'add_connection', path: databasePath, name: 'shop' })
    const removed = await tool.execute({ action: 'remove_connection', connection: 'shop' })
    assert.equal(removed.removed, true)
    assert.deepEqual((await tool.execute({ action: 'connections' })).connections, [])
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an unknown action fails with the action name', { skip }, async () => {
  const { directory, databasePath, store, tool } = fixture()
  try {
    await tool.execute({ action: 'add_connection', path: databasePath, name: 'shop' })
    await assert.rejects(() => tool.execute({ action: 'drop_everything' }), /unknown action drop_everything/)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the tool output is trimmed when a result is very long', { skip }, async () => {
  const { directory, databasePath, store, tool } = fixture()
  try {
    await tool.execute({ action: 'add_connection', path: databasePath, name: 'shop' })
    const blocks = tool.output.render({}, { text: 'x'.repeat(50000) })
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /truncated/)
    assert.ok(blocks[0].text.length < 50000)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
