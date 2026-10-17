import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyStatement, encodeCell, inspectScript, quoteIdent, splitStatements, toCsv, toJson,
} from '../lib/sql.js'

test('splitStatements keeps literals and comments intact', () => {
  const sql = "select ';' as a; select 2 -- ; not a split\n; select 3 /* ; */"
  const statements = splitStatements(sql)
  assert.equal(statements.length, 3)
  assert.equal(statements[0], "select ';' as a")
  assert.equal(statements[2], 'select 3 /* ; */')
})

test('splitStatements drops empty trailing statements', () => {
  assert.deepEqual(splitStatements('select 1;   ;'), ['select 1'])
  assert.deepEqual(splitStatements('   '), [])
})

test('splitStatements handles doubled quotes inside literals', () => {
  const statements = splitStatements("select 'it''s; fine' as x; select 2")
  assert.equal(statements.length, 2)
  assert.equal(statements[0], "select 'it''s; fine' as x")
})

test('classifyStatement separates reads from writes', () => {
  assert.equal(classifyStatement('SELECT * FROM t'), 'read')
  assert.equal(classifyStatement('  -- comment\nselect 1'), 'read')
  assert.equal(classifyStatement('EXPLAIN QUERY PLAN SELECT 1'), 'read')
  assert.equal(classifyStatement('insert into t values (1)'), 'write')
  assert.equal(classifyStatement('DELETE FROM t'), 'write')
  assert.equal(classifyStatement('CREATE TABLE t (id integer)'), 'write')
})

test('classifyStatement reads the real verb of a CTE', () => {
  assert.equal(classifyStatement('with x as (select 1) select * from x'), 'read')
  assert.equal(classifyStatement('with x as (select 1) delete from t'), 'write')
})

test('classifyStatement treats a pragma assignment as a write', () => {
  assert.equal(classifyStatement('PRAGMA table_info(t)'), 'read')
  assert.equal(classifyStatement('PRAGMA journal_mode = wal'), 'write')
})

test('classifyStatement reports unknown verbs instead of guessing read', () => {
  assert.equal(classifyStatement('attach database "x.db" as x'), 'write')
  assert.equal(classifyStatement('frobnicate everything'), 'unknown')
  assert.equal(classifyStatement(''), 'unknown')
})

test('a keyword hidden inside a literal does not make a statement a write', () => {
  assert.equal(classifyStatement("select 'delete from t' as x"), 'read')
})

test('inspectScript reports whether any statement writes', () => {
  const read = inspectScript('select 1; select 2')
  assert.equal(read.hasWrite, false)
  const mixed = inspectScript('select 1; update t set a = 1')
  assert.equal(mixed.hasWrite, true)
  assert.deepEqual(mixed.verdicts, ['read', 'write'])
})

test('quoteIdent doubles embedded quotes', () => {
  assert.equal(quoteIdent('plain'), '"plain"')
  assert.equal(quoteIdent('we"ird'), '"we""ird"')
})

test('encodeCell makes blobs explicit and keeps scalars', () => {
  assert.equal(encodeCell(null), null)
  assert.equal(encodeCell(3), 3)
  assert.equal(encodeCell('x'), 'x')
  const blob = encodeCell(new Uint8Array([1, 2, 3]))
  assert.equal(blob.$blob, true)
  assert.equal(blob.size, 3)
  assert.equal(blob.base64, Buffer.from([1, 2, 3]).toString('base64'))
})

test('toCsv quotes cells that contain separators or quotes', () => {
  const csv = toCsv(['a', 'b'], [['x,y', 'he said "hi"'], [null, 2]], { bom: false })
  assert.equal(csv, 'a,b\r\n"x,y","he said ""hi"""\r\n,2\r\n')
})

test('toCsv writes a byte order mark by default', () => {
  assert.equal(toCsv(['a'], [['1']]).charCodeAt(0), 0xfeff)
})

test('toJson maps rows onto column names', () => {
  const json = JSON.parse(toJson(['id', 'name'], [[1, 'a'], [2, null]]))
  assert.deepEqual(json, [{ id: 1, name: 'a' }, { id: 2, name: null }])
})
