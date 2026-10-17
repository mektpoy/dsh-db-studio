/**
 * The password store adapter.
 *
 * Its whole job is to find `ctx.credentials` at call time: services are mounted
 * in composition order, and the credential provider can come after this plugin,
 * so a lookup during activation returns nothing. These tests use a fake context
 * whose service appears only after the adapter was created.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createSecrets } from '../index.js'

/** A credential service stand-in backed by a Map. */
function fakeCredentials() {
  const values = new Map()
  return {
    values,
    async resolve(ref) { return values.has(ref) ? { value: values.get(ref) } : undefined },
    async set(ref, value) { values.set(ref, value) },
    async unset(ref) { values.delete(ref) },
  }
}

test('the reference is an environment-variable name derived from the id', () => {
  const secrets = createSecrets({ get: () => undefined })
  const ref = secrets.refFor('8cf81e21-2d25-4c70-adf2-7ac0e8d1fcad')
  assert.equal(ref, 'DB_STUDIO_PASSWORD_8CF81E21_2D25_4C70_ADF2_7AC0E8D1FCAD')
  // The credential store only accepts `[A-Za-z_][A-Za-z0-9_]*`. Connection ids are
  // UUIDs, whose hyphens sit in fixed places, so two ids never collapse onto one
  // reference even though the separator becomes an underscore.
  assert.match(ref, /^[A-Za-z_][A-Za-z0-9_]*$/)
  assert.equal(secrets.refFor('8cf81e21-2d25-4c70-adf2-7ac0e8d1fcae'),
    'DB_STUDIO_PASSWORD_8CF81E21_2D25_4C70_ADF2_7AC0E8D1FCAE')
})

test('the store is found when it appears after the adapter was created', async () => {
  const container = { get: () => undefined }
  const secrets = createSecrets(container)
  await assert.rejects(() => secrets.set('id-1', 'secret'), /no credential store/)

  // The provider mounts later, which is what happens in a real composition.
  const credentials = fakeCredentials()
  container.get = name => (name === 'credentials' ? credentials : undefined)

  await secrets.set('id-1', 'secret')
  assert.equal(credentials.values.get(secrets.refFor('id-1')), 'secret')
  assert.equal(await secrets.get('id-1'), 'secret')

  await secrets.clear('id-1')
  assert.equal(await secrets.get('id-1'), undefined)
})

test('a context that only exposes the service property still works', async () => {
  const credentials = fakeCredentials()
  const secrets = createSecrets({ get: () => undefined, credentials })
  await secrets.set('id-2', 'other')
  assert.equal(await secrets.get('id-2'), 'other')
})

test('a context that throws on lookup is treated as having no store', async () => {
  const secrets = createSecrets({
    get() { throw new Error('not injected') },
    get credentials() { throw new Error('service accessor refused') },
  })
  assert.equal(await secrets.get('id-3'), undefined)
  await assert.rejects(() => secrets.set('id-3', 'x'), /no credential store/)
  // Clearing without a store is a no-op rather than an error.
  await secrets.clear('id-3')
})

test('a failing resolve reads as no password instead of throwing', async () => {
  const credentials = {
    async resolve() { throw new Error('store unavailable') },
    async set() {},
    async unset() {},
  }
  const secrets = createSecrets({ get: name => (name === 'credentials' ? credentials : undefined) })
  assert.equal(await secrets.get('id-4'), undefined)
})
