import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const result = await build({ entryPoints: [resolve(root, 'src/client.js')], bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2023', external: ['react'], minify: false })
writeFileSync(resolve(root, 'lib/client.js'), `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`)
