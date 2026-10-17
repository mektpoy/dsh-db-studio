/**
 * PostgreSQL driver tests.
 *
 * These run only when a server is supplied, because the repository must stay
 * testable without one:
 *
 *   DB_STUDIO_TEST_PG_HOST, _PORT, _DATABASE, _USER, _PASSWORD, _SSL=1
 *
 * Everything here is read-only: the fixtures discover a table the server already
 * has, and the only write test checks that a write is refused before it runs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { PostgresDriver } from '../lib/postgres-driver.js'

const config = {
  host: process.env.DB_STUDIO_TEST_PG_HOST || '',
  port: Number(process.env.DB_STUDIO_TEST_PG_PORT || 5432),
  dbname: process.env.DB_STUDIO_TEST_PG_DATABASE || '',
  username: process.env.DB_STUDIO_TEST_PG_USER || '',
  password: process.env.DB_STUDIO_TEST_PG_PASSWORD || '',
  ssl: process.env.DB_STUDIO_TEST_PG_SSL === '1',
}
const skip = config.host && config.dbname
  ? false
  : 'set DB_STUDIO_TEST_PG_HOST and _DATABASE to run PostgreSQL tests'

/** Open a driver, hand it to the test, always close. */
async function withDriver(options, run) {
  const driver = new PostgresDriver({ ...config, readOnly: true, ...options })
  try {
    return await run(driver)
  } finally {
    await driver.close()
  }
}

/** The first table the server exposes, so the tests do not hard-code a schema. */
async function firstTable(driver) {
  const objects = await driver.objects()
  const table = objects.find(object => object.type === 'table')
  assert.ok(table, 'the database should expose at least one table')
  return table
}

test('reports the server version and database size', { skip }, async () => {
  await withDriver({}, async driver => {
    const info = await driver.test()
    assert.equal(info.ok, true)
    assert.match(info.version, /PostgreSQL/)
    assert.equal(info.database, config.dbname)
    assert.equal(info.readOnly, true)
    assert.ok(info.bytes > 0)
  })
})

test('lists tables and views with schema-qualified names', { skip }, async () => {
  await withDriver({}, async driver => {
    const objects = await driver.objects()
    assert.ok(objects.length > 0)
    for (const object of objects) {
      assert.ok(object.schema)
      assert.ok(object.type === 'table' || object.type === 'view')
      // `public` stays implicit; every other schema is part of the name.
      assert.equal(
        object.name,
        object.schema === 'public' ? object.table : `${object.schema}.${object.table}`,
      )
    }
  })
})

test('describes a table with columns, keys and a rebuilt create statement', { skip }, async () => {
  await withDriver({}, async driver => {
    const table = await firstTable(driver)
    const detail = await driver.describe(table.name)
    assert.equal(detail.name, table.name)
    assert.ok(detail.columns.length > 0)
    assert.ok(detail.columns.every(column => typeof column.name === 'string' && column.type))
    assert.match(detail.ddl, /^CREATE TABLE /)
    assert.ok(Array.isArray(detail.indexes))
    assert.ok(Array.isArray(detail.foreignKeys))
  })
})

test('preview returns a page, its columns and the total', { skip }, async () => {
  await withDriver({}, async driver => {
    const table = await firstTable(driver)
    const page = await driver.preview(table.name, { limit: 2 })
    assert.equal(page.table, table.name)
    assert.ok(Array.isArray(page.columns))
    assert.ok(page.rows.length <= 2)
    if (page.rows.length > 0) {
      assert.deepEqual(Object.keys(page.rows[0]), page.columns.map(column => column.name))
    }
  })
})

test('runs a read statement and names its columns', { skip }, async () => {
  await withDriver({}, async driver => {
    const result = await driver.run('select 1 as one, \'two\' as two')
    assert.equal(result.statements[0].rowCount, 1)
    assert.deepEqual(result.statements[0].columns.map(column => column.name), ['one', 'two'])
    assert.deepEqual(result.statements[0].rows[0], [1, 'two'])
  })
})

test('a read-only connection refuses a write before execution', { skip }, async () => {
  await withDriver({}, async driver => {
    await assert.rejects(
      () => driver.run("create table db_studio_should_not_exist (id int)"),
      /read-only/,
    )
  })
})

test('a write needs allowWrite even on a writable connection', { skip }, async () => {
  await withDriver({ readOnly: false }, async driver => {
    await assert.rejects(
      () => driver.run('create table db_studio_should_not_exist (id int)'),
      /allowWrite/,
    )
  })
})

test('explain returns the plan without running the statement', { skip }, async () => {
  await withDriver({}, async driver => {
    const plan = await driver.explain('select 1')
    assert.ok(plan.rows.length > 0)
    assert.ok(plan.columns.some(column => column.name === 'QUERY PLAN'))
  })
})

test('stats reports the database and its object counts', { skip }, async () => {
  await withDriver({}, async driver => {
    const stats = await driver.stats()
    assert.equal(stats.database, config.dbname)
    assert.match(stats.version, /PostgreSQL/)
    assert.ok(stats.tables >= 1)
    assert.ok(stats.bytes > 0)
  })
})

test('an unknown table name fails with a readable message', { skip }, async () => {
  await withDriver({}, async driver => {
    await assert.rejects(() => driver.describe('public.db_studio_missing_table'), /no table or view named/)
  })
})

test('the service saves a PostgreSQL connection, keeps the password aside and runs a query', { skip }, async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Studio } = await import('../lib/studio.js')
  const { StudioStore } = await import('../lib/store.js')

  const directory = mkdtempSync(join(tmpdir(), 'db-studio-pg-'))
  const values = new Map()
  const secrets = {
    async get(id) { return values.get(id) },
    async set(id, value) { values.set(id, value) },
    async clear(id) { values.delete(id) },
  }
  const store = new StudioStore(directory)
  const studio = new Studio({ store, secrets })
  try {
    const { id } = await studio.saveConnection({
      name: 'remote',
      driver: 'postgres',
      host: config.host,
      port: config.port,
      dbname: config.dbname,
      username: config.username,
      password: config.password,
      ssl: config.ssl,
      readOnly: true,
    })
    assert.equal(values.get(id), config.password)

    const info = await studio.test(id)
    assert.equal(info.ok, true)
    assert.match(info.version, /PostgreSQL/)

    const schema = await studio.schema(id)
    assert.ok(schema.objects.length > 0)
    const table = schema.objects.find(object => object.type === 'table').name

    const detail = await studio.schema(id, table)
    assert.ok(detail.detail.columns.length > 0)

    const query = await studio.query(id, 'select 41 + 1 as answer')
    assert.deepEqual(query.statements[0].rows[0], [42])

    const csv = await studio.exportData(id, { sql: 'select 1 as n', format: 'csv' })
    assert.match(csv.body.replace(/^\uFEFF/, ''), /^n\r\n1/)

    await assert.rejects(
      () => studio.query(id, 'create table db_studio_should_not_exist (id int)', { allowWrite: true }),
      /read-only/,
    )

    const history = studio.history(id, 10)
    assert.ok(history.some(entry => entry.ok && entry.sql.includes('41 + 1')))
    assert.ok(history.some(entry => entry.ok === false))
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
