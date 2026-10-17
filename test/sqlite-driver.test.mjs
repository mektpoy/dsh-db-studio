import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteDriver, sqliteStatus } from '../lib/sqlite-driver.js'

const available = sqliteStatus().available
const skip = available ? false : 'this runtime has no node:sqlite'

/** Build a small database file and return a driver opened for writing. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'db-studio-'))
  const path = join(directory, 'sample.db')
  const writer = new SqliteDriver({ path, readOnly: false })
  writer.open()
  writer.run(`
    CREATE TABLE author (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE book (
      id INTEGER PRIMARY KEY,
      author_id INTEGER NOT NULL REFERENCES author(id),
      title TEXT NOT NULL,
      pages INTEGER
    );
    CREATE UNIQUE INDEX book_title ON book (title);
    INSERT INTO author (id, name) VALUES (1, 'Ada'), (2, 'Grace');
    INSERT INTO book (id, author_id, title, pages) VALUES
      (1, 1, 'Notes', 120), (2, 1, 'More Notes', 240), (3, 2, 'Compilers', NULL);
  `, { allowWrite: true })
  writer.close()
  return { directory, path }
}

test('lists tables and views with row counts', { skip }, () => {
  const { directory, path } = fixture()
  try {
    const driver = new SqliteDriver({ path, readOnly: true })
    const objects = driver.objects()
    driver.close()
    assert.deepEqual(objects.map(item => item.name), ['author', 'book'])
    assert.equal(objects[0].rows, 2)
    assert.equal(objects[1].rows, 3)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('describes columns, indexes, foreign keys and DDL', { skip }, () => {
  const { directory, path } = fixture()
  try {
    const driver = new SqliteDriver({ path, readOnly: true })
    const detail = driver.describe('book')
    driver.close()
    assert.equal(detail.type, 'table')
    assert.equal(detail.rows, 3)
    assert.deepEqual(detail.columns.map(column => column.name), ['id', 'author_id', 'title', 'pages'])
    assert.equal(detail.columns[0].primaryKey, true)
    assert.equal(detail.columns[2].notNull, true)
    const unique = detail.indexes.find(index => index.name === 'book_title')
    assert.equal(unique.unique, true)
    assert.deepEqual(unique.columns, ['title'])
    assert.equal(detail.foreignKeys[0].table, 'author')
    assert.match(detail.ddl, /CREATE TABLE book/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('preview pages rows and reports the total', { skip }, () => {
  const { directory, path } = fixture()
  try {
    const driver = new SqliteDriver({ path, readOnly: true })
    const page = driver.preview('book', { limit: 2, offset: 1, orderBy: 'id', dir: 'asc' })
    assert.deepEqual(page.rows.map(row => row.id), [2, 3])
    assert.equal(page.total, 3)
    assert.equal(page.hasMore, false)
    assert.deepEqual(page.columns.map(column => column.name), ['id', 'author_id', 'title', 'pages'])
    driver.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('preview filters with a substring match', { skip }, () => {
  const { directory, path } = fixture()
  try {
    const driver = new SqliteDriver({ path, readOnly: true })
    const page = driver.preview('book', { filters: { title: 'Notes' } })
    assert.deepEqual(page.rows.map(row => row.title), ['Notes', 'More Notes'])
    assert.equal(page.total, 2)
    driver.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('run returns columns and rows for a read statement', { skip }, () => {
  const { directory, path } = fixture()
  try {
    const driver = new SqliteDriver({ path, readOnly: true })
    const result = driver.run('select title, pages from book order by id')
    assert.equal(result.statements[0].rowCount, 3)
    assert.deepEqual(result.statements[0].columns.map(column => column.name), ['title', 'pages'])
    assert.deepEqual(result.statements[0].rows[0], ['Notes', 120])
    driver.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('run marks a result set truncated when it exceeds the row ceiling', { skip }, () => {
  const { directory, path } = fixture()
  try {
    const driver = new SqliteDriver({ path, readOnly: true })
    const result = driver.run('select * from book', { maxRows: 2 })
    assert.equal(result.statements[0].truncated, true)
    assert.equal(result.statements[0].rows.length, 2)
    assert.equal(result.statements[0].rowCount, 3)
    driver.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a read-only connection refuses a write before execution', { skip }, () => {
  const { directory, path } = fixture()
  try {
    const driver = new SqliteDriver({ path, readOnly: true })
    assert.throws(() => driver.run("insert into author (name) values ('x')"), /read-only/)
    const count = driver.run('select count(*) as n from author').statements[0].rows[0][0]
    assert.equal(count, 2)
    driver.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('allowWrite is required even on a writable connection', { skip }, () => {
  const { directory, path } = fixture()
  try {
    const driver = new SqliteDriver({ path, readOnly: false })
    assert.throws(() => driver.run("insert into author (name) values ('x')"), /allowWrite/)
    driver.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a multi-statement write runs in one transaction and rolls back on failure', { skip }, () => {
  const { directory, path } = fixture()
  try {
    const driver = new SqliteDriver({ path, readOnly: false })
    driver.run("insert into author (name) values ('A'); insert into author (name) values ('B')", { allowWrite: true })
    assert.equal(driver.run('select count(*) as n from author').statements[0].rows[0][0], 4)
    // The second statement violates NOT NULL, so the first insert must be undone.
    assert.throws(() => driver.run("insert into author (name) values ('C'); insert into author (id) values (9)", { allowWrite: true }))
    assert.equal(driver.run('select count(*) as n from author').statements[0].rows[0][0], 4)
    driver.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('explain returns query plan rows', { skip }, () => {
  const { directory, path } = fixture()
  try {
    const driver = new SqliteDriver({ path, readOnly: true })
    const plan = driver.explain('select * from book where title = ?')
    assert.ok(plan.rows.length > 0)
    assert.ok(plan.columns.some(column => column.name === 'detail'))
    driver.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('stats reports page facts for the file', { skip }, () => {
  const { directory, path } = fixture()
  try {
    const driver = new SqliteDriver({ path, readOnly: true })
    const stats = driver.stats()
    assert.equal(stats.pageSize > 0, true)
    assert.equal(stats.pageCount > 0, true)
    assert.equal(typeof stats.bytes, 'number')
    driver.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('opening a missing file read-only fails with the driver error', { skip }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'db-studio-'))
  try {
    const driver = new SqliteDriver({ path: join(directory, 'nope.db'), readOnly: true })
    assert.throws(() => driver.open())
    driver.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
