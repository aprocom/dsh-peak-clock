/**
 * Regenerate the generated regions of `client.js`.
 *
 * The browser bundle cannot import the Host modules: the loader answers only
 * the package's `./client` export, so the engine, the price table and the
 * bundled calendar have to travel inside it. This script copies them from
 * their canonical files, and `test/engine-sync.test.mjs` fails when the copy
 * and the source disagree, so a change to either side cannot silently drift.
 *
 * Run `node scripts/sync-client.mjs` after editing `lib/engine.js`,
 * `lib/rules.js` or `lib/holidays.json`.
 */

import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)

/**
 * Read a file beside the package root.
 * @param {string} path - a package-relative path.
 * @returns {string} its contents.
 */
function read(path) {
  return readFileSync(new URL(path, root), 'utf8')
}

/**
 * Drop the `export ` keyword so the module body becomes a plain block.
 * @param {string} source - an ES module body.
 * @returns {string} the same body without its export keywords.
 */
function stripExports(source) {
  return source.replace(/^export /gm, '').trimEnd()
}

const regions = [
  ['rules', stripExports(read('lib/rules.js'))],
  ['engine', stripExports(read('lib/engine.js'))],
  ['holidays', `const HOLIDAY_CALENDAR = ${read('lib/holidays.json').trimEnd()}`],
]

let client = read('client.js')

for (const [name, body] of regions) {
  const begin = `    // #region generated:${name}`
  const end = `    // #endregion generated:${name}`
  const start = client.indexOf(begin)
  const stop = client.indexOf(end)
  if (start < 0 || stop < 0 || stop < start) throw new Error(`missing generated region: ${name}`)
  const indented = body
    .split('\n')
    .map((line) => (line === '' ? '' : `    ${line}`))
    .join('\n')
  client = `${client.slice(0, start + begin.length)}\n${indented}\n${client.slice(stop)}`
}

writeFileSync(new URL('client.js', root), client)
console.log(`synced ${regions.map(([name]) => name).join(', ')} -> client.js`)
