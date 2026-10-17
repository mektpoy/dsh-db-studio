/**
 * The panel renders text through `t('key')`, and a missing entry falls back to
 * the raw key, which surfaces as `conn.readOnlyHint` on screen. This test reads
 * the dictionaries and the call sites out of client.js and compares them, so a
 * typo fails here instead of in the browser.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(HERE, '..', 'client.js'), 'utf8')

const zhStart = source.indexOf('const ZH = {')
const enStart = source.indexOf('const EN = {')
const apiStart = source.indexOf('// ------------------------------------------------------------------ api')

assert.ok(zhStart > 0 && enStart > zhStart && apiStart > enStart, 'the dictionary blocks must be findable')

const zhBlock = source.slice(zhStart, enStart)
const enBlock = source.slice(enStart, apiStart)

/**
 * Keys declared in one dictionary literal. Entries may share a line, so the match
 * is not anchored; a quoted run followed by a colon is a key, never a value.
 * `panel` is the only unquoted key.
 */
function keysOf(block) {
  const keys = new Set()
  for (const match of block.matchAll(/'([^']+)'\s*:/g)) keys.add(match[1])
  if (/(?:^|[{,\s])panel\s*:/m.test(block)) keys.add('panel')
  return keys
}

/** Keys passed to `t(...)` anywhere in the client half. */
const usedKeys = new Set(
  [...source.matchAll(/\bt\(\s*'([^']+)'/g)].map(match => match[1]),
)

const zh = keysOf(zhBlock)
const en = keysOf(enBlock)

test('the dictionaries declare the same keys', () => {
  const onlyZh = [...zh].filter(key => !en.has(key))
  const onlyEn = [...en].filter(key => !zh.has(key))
  assert.deepEqual(onlyZh, [], `missing from en.json: ${onlyZh.join(', ')}`)
  assert.deepEqual(onlyEn, [], `missing from zh.json: ${onlyEn.join(', ')}`)
})

test('every key the panel asks for exists in both dictionaries', () => {
  assert.ok(usedKeys.size > 40, `expected the panel to use many keys, found ${usedKeys.size}`)
  const missingZh = [...usedKeys].filter(key => !zh.has(key))
  const missingEn = [...usedKeys].filter(key => !en.has(key))
  assert.deepEqual(missingZh, [], `used but not declared (zh): ${missingZh.join(', ')}`)
  assert.deepEqual(missingEn, [], `used but not declared (en): ${missingEn.join(', ')}`)
})

test('no dictionary entry is left unused', () => {
  // A stale entry is not a bug, but it is dead text that drifts. Report it so the
  // dictionaries stay a description of what the panel actually shows.
  const unused = [...zh].filter(key => !usedKeys.has(key))
  assert.deepEqual(unused, [], `declared but never used: ${unused.join(', ')}`)
})
