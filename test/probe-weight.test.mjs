import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProbe } from '../lib/probe.js'

/** The probe only ever asks the registry for a service; an empty one answers every key. */
function probeFor(dshHome, options = {}) {
  const services = { get: () => undefined }
  return createProbe({ get: (key) => services.get(key) }, { dshHome, ...options })
}

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-weight-'))
  try {
    return await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('sessionWeight() is null when this home has no sessions directory', async () => {
  await withHome(async (home) => {
    const probe = probeFor(home)
    assert.equal(await probe.sessionWeight('9c1f2d3e-0000-4000-8000-000000000001'), null)
  })
})

test('sessionWeight() returns the compressed size and the file it measured', async () => {
  await withHome(async (home) => {
    const sessionId = 'session-9c1f2d3e-0000-4000-8000-000000000002'
    const dir = join(home, 'sessions', '--Users-apple-Desktop--', sessionId)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    const body = Buffer.alloc(1536, 0x28)
    await writeFile(file, body)

    const probe = probeFor(home)
    const weight = await probe.sessionWeight(sessionId)
    assert.deepEqual(weight, { bytes: (await stat(file)).size, file })
    assert.equal(weight.bytes, 1536)
  })
})

test('sessionWeight() accepts the bare id and the session- prefixed id alike', async () => {
  await withHome(async (home) => {
    const id = '7d4e5f60-1111-4111-8111-111111111111'
    const dir = join(home, 'sessions', '--Users-apple-Desktop-work--', `session-${id}`)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    await writeFile(file, Buffer.alloc(64, 0x01))

    const probe = probeFor(home)
    assert.equal((await probe.sessionWeight(id)).file, file)
    assert.equal((await probe.sessionWeight(`session-${id}`)).file, file)
  })
})

test('sessionWeight() is null for an input that cannot name a session', async () => {
  await withHome(async (home) => {
    const probe = probeFor(home)
    assert.equal(await probe.sessionWeight(null), null)
    assert.equal(await probe.sessionWeight(undefined), null)
    assert.equal(await probe.sessionWeight(''), null)
    assert.equal(await probe.sessionWeight(42), null)
    assert.equal(await probe.sessionWeight({ id: 'x' }), null)
  })
})

test('sessionWeight() is null when the bucket holds no log, an empty one, or a directory in its place', async () => {
  await withHome(async (home) => {
    const bucket = join(home, 'sessions', '--Users-apple-Desktop--')
    const empty = join(bucket, 'session-1a2b3c4d-2222-4222-8222-222222222222')
    await mkdir(empty, { recursive: true })
    await writeFile(join(empty, 'session.v4.jsonl.zstd'), Buffer.alloc(0))

    // The expected file name is occupied by a directory: stat succeeds, opening it would not.
    const occupied = join(bucket, 'session-5e6f7a8b-3333-4333-8333-333333333333')
    await mkdir(join(occupied, 'session.v4.jsonl.zstd'), { recursive: true })

    const probe = probeFor(home)
    assert.equal(await probe.sessionWeight('1a2b3c4d-2222-4222-8222-222222222222'), null)
    assert.equal(await probe.sessionWeight('5e6f7a8b-3333-4333-8333-333333333333'), null)
    assert.equal(await probe.sessionWeight('00000000-4444-4444-8444-444444444444'), null)
  })
})

test('sessionWeight() reads a log that a plain restore already found in another bucket', async () => {
  await withHome(async (home) => {
    // Buckets are enumerated, not guessed: a transcript under a bucket the caller never names
    // still weighs the same.
    const id = '0f1e2d3c-5555-4555-8555-555555555555'
    const dir = join(home, 'sessions', '--private-var-folders--', `session-${id}`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(3333, 0x7f))

    const probe = probeFor(home)
    const weight = await probe.sessionWeight(id)
    assert.equal(weight.bytes, 3333)
  })
})
