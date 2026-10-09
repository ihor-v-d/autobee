// node generate.js <autobee checkout at 3d26566 (2.6.0)> <out dir>
const os = require('os')
const path = require('path')
const fs = require('fs/promises')
const [root, out] = process.argv.slice(2)
// resolve everything from the checkout so no module is loaded twice
const b4a = require(path.join(root, 'node_modules/b4a'))
const Corestore = require(path.join(root, 'node_modules/corestore'))
const Autobee = require(path.join(root, 'index.js'))

const ENTRIES = 100

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

function encode(data) {
  return b4a.from(JSON.stringify(data))
}

function entry(i) {
  return 'entry/' + String(i).padStart(4, '0')
}

;(async () => {
  // only what this writes, so the out dir can be the fixture dir holding this script
  await fs.rm(path.join(out, 'joiner'), { recursive: true, force: true })
  await fs.rm(path.join(out, 'meta.json'), { force: true })

  // the creator's storage is thrown away: it is the device that left
  const creatorDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autobee-creator-'))
  const creatorStore = new Corestore(creatorDir)
  const creator = new Autobee(creatorStore, null, { apply })
  await creator.ready()

  for (let i = 0; i < ENTRIES; i++) await creator.append(encode({ key: entry(i) }))

  const joinerStore = new Corestore(path.join(out, 'joiner'))
  const joiner = new Autobee(joinerStore, creator.key, { apply })
  await joiner.ready()
  await creator.append(encode({ key: 'add/joiner', add: b4a.toString(joiner.local.key, 'hex') }))

  const s1 = creator.replicate(true)
  const s2 = joiner.replicate(false)
  s1.pipe(s2).pipe(s1)

  // a joiner this far behind catches up by fast-forwarding, so it never fetches most system blocks
  while (!joiner.writable || !(await joiner.view.get(b4a.from(entry(ENTRIES - 1))))) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  await joiner.append(encode({ key: 'joiner/wrote' }))
  await joiner.update()

  const meta = {
    generatedFrom: 'autobee 2.6.0 (3d26566), corestore 7.12.2',
    baseKey: b4a.toString(creator.key, 'hex'),
    joinerLocalKey: b4a.toString(joiner.local.key, 'hex'),
    entries: ENTRIES,
    joinerFastForwards: joiner.stats.fastForwards
  }

  s1.destroy()
  s2.destroy()
  await joiner.close()
  await creator.close()
  await joinerStore.close()
  await creatorStore.close()
  await fs.rm(creatorDir, { recursive: true, force: true })

  await fs.writeFile(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  console.log(JSON.stringify(meta, null, 2))
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
