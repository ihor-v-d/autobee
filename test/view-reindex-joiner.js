const IS_BARE = typeof global.Bare !== 'undefined'

const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const os = IS_BARE ? null : require('os')

const Autobee = require('../index.js')

const skip = IS_BARE || !['linux', 'darwin'].includes(os.platform())

const path = skip ? null : require('path')
const fs = skip ? null : require('fs/promises')

const FIXTURE = skip
  ? null
  : path.join(__dirname, 'fixtures/migration/autobee-v2.6-ff-joiner-darwin')
const META = skip ? null : require(path.join(FIXTURE, 'meta.json'))

// past the network boot a strict reindex waits out first, so a pending append here is wedged
const SETTLE_MS = 15000

async function apply(batch, view, base) {
  for (const { value } of batch) {
    if (!value) continue
    const data = JSON.parse(b4a.toString(value))
    if (data.add) await base.addWriter(b4a.from(data.add, 'hex'))
    const w = view.write()
    w.tryPut(b4a.from(data.key), value)
    await w.flush()
  }
}

test(
  'strict reindex - a joiner that fast-forwarded onto a creator now gone still appends',
  { skip },
  async (t) => {
    t.ok(META.joinerFastForwards > 0, 'the fixture joiner caught up by fast-forwarding')

    const dir = await t.tmp()
    await fs.cp(path.join(FIXTURE, 'joiner'), dir, { recursive: true })

    const store = new Corestore(dir, { allowBackup: true })
    const auto = new Autobee(store, b4a.from(META.baseKey, 'hex'), { apply, strictReindex: true })
    // close waits on the drain a wedged reindex holds, so a failing run must still end
    t.teardown(() => settles(auto.close().then(() => store.close())))
    await auto.ready()

    const last = 'entry/' + String(META.entries - 1).padStart(4, '0')
    t.ok(await auto.view.get(b4a.from(last)), 'the history it fast-forwarded onto reads')

    const append = auto.append(b4a.from(JSON.stringify({ key: 'after/upgrade' })))
    t.ok(await settles(append), 'an append lands with no peer holding the old system blocks')
    t.ok(await auto.view.get(b4a.from('after/upgrade')), 'and applies')
  }
)

async function settles(promise, ms = SETTLE_MS) {
  let timer = null
  const expired = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, false)
  })

  try {
    return await Promise.race([promise.then(() => true), expired])
  } finally {
    clearTimeout(timer)
  }
}
