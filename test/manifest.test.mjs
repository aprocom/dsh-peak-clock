import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const exists = (path) => {
  try {
    return statSync(new URL(path, root)).isFile()
  } catch {
    return false
  }
}

const manifest = JSON.parse(read('package.json'))
const patch = read('cordis.patch.yml')
const client = read('client.js')

test('the manifest declares a bundle and a browser half', () => {
  assert.equal(manifest.name, 'dsh-peak-clock')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.scripts.test, 'node --test')
})

test('the patch inserts one row that resolves this package', () => {
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /^\s+- id: peak-clock$/m)
  assert.match(patch, /^\s+name: dsh-peak-clock$/m)
})

test('every file the manifest ships exists', () => {
  const required = [
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'lib/engine.js',
    'lib/rules.js',
    'lib/holidays.json',
    'locale/en.json',
    'locale/ru.json',
    'locale/zh.json',
    'icon.svg',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
  ]
  for (const path of required) assert.ok(exists(path), `${path} exists`)
  for (const entry of manifest.files) {
    if (entry.includes('*')) {
      const probe = entry.replace('*', 'en')
      assert.ok(exists(probe), `${entry} matches ${probe}`)
      continue
    }
    if (exists(entry)) continue
    const segments = entry.split('/')
    const directory = segments.length > 1 || !segments[0].includes('.')
    assert.ok(directory && statSync(new URL(`${entry}/`, root)).isDirectory(), `${entry} from files exists`)
  }
  assert.ok(manifest.files.includes('lib'))
  assert.ok(manifest.files.includes('locale/*.json'))
})

test('the browser bundle registers itself under the package name', () => {
  assert.match(client, /^window\.__ModuleLoader__\.load\(\{/)
  assert.match(client, /id: 'dsh-peak-clock'/)
  assert.match(client, /ctx\.slots\.inject\('conversation\.input\.right'/)
  assert.match(client, /id: 'plugin\.peak-clock'/)
  assert.equal(client.includes('@deepseek-ai/dsh-client-ui-primitives'), false)
})

test('the display metadata describes the plugin in every locale', () => {
  for (const language of ['en', 'ru', 'zh']) {
    const meta = JSON.parse(read(`locale/${language}.json`)).meta
    assert.equal(typeof meta.title, 'string', `${language} title`)
    assert.equal(typeof meta.description, 'string', `${language} description`)
    assert.ok(meta.title.length >= 3, `${language} title length`)
    assert.ok(meta.description.length > 120, `${language} description length`)
    assert.equal(meta.detail, undefined, 'no detail document to keep in sync')
  }
})

test('the icon is one small self-contained SVG', () => {
  const icon = read('icon.svg')
  assert.ok(statSync(new URL('icon.svg', root)).size <= 256 * 1024)
  assert.match(icon, /^<svg[^>]+viewBox="0 0 36 36"/)
  assert.match(icon, /<\/svg>\s*$/)
  assert.equal(icon.includes('<script'), false)
  assert.equal(icon.includes('foreignObject'), false)
  assert.equal(icon.includes('<text'), false)
  assert.equal(/\shref=/.test(icon), false)
  assert.equal(/url\(/.test(icon), false)
})

test('the bundled calendar is internally consistent', () => {
  const calendar = JSON.parse(read('lib/holidays.json'))
  assert.equal(typeof calendar.source, 'string')
  const years = Object.keys(calendar.years).sort()
  assert.deepEqual(years, ['2026', '2027'])
  for (const year of years) {
    const entry = calendar.years[year]
    assert.equal(typeof calendar.papers[year], 'string')
    assert.ok(Object.keys(entry.holidays).length > 20, `${year} holidays`)
    assert.ok(Object.keys(entry.workdays).length >= 5, `${year} workdays`)
    for (const [date, key] of Object.entries(entry.holidays)) {
      assert.ok(date.startsWith(`${year}-`), `${date} belongs to ${year}`)
      assert.match(key, /^[a-z][a-z-]+$/)
      assert.equal(entry.workdays[date], undefined, `${date} is not also a workday`)
    }
    for (const date of Object.keys(entry.workdays)) assert.ok(date.startsWith(`${year}-`), date)
  }
})

test('the changelog opens with the shipped version', () => {
  const changelog = read('CHANGELOG.md')
  const first = changelog.split('\n').find((line) => line.startsWith('## '))
  assert.ok(first.includes(manifest.version), `${first} names ${manifest.version}`)
})
