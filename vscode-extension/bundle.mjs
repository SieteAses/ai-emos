#!/usr/bin/env node
/**
 * bundle.mjs — empaqueta el núcleo y los assets DENTRO de la extensión, para que
 * el `.vsix` sea self-contained (funcione sin el repo ni el plugin).
 *
 * Copia:
 *   ../core                              → ./bundled/core
 *   ../sdk                               → ./bundled/sdk
 *   ../skills/visualize-session/assets   → ./bundled/assets
 *
 * extension.js usa ./bundled/ si existe (ver resolveBase()); en dev (monorepo)
 * cae a ../core y ../skills/.../assets.
 *
 * Se corre en `vscode:prepublish` (al hacer `vsce package`). Para desarrollo NO
 * hace falta: la extensión lee directo del repo.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const OUT = path.join(HERE, 'bundled')

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}

rmrf(OUT)
copyDir(path.join(REPO, 'core'), path.join(OUT, 'core'))
copyDir(path.join(REPO, 'sdk'), path.join(OUT, 'sdk'))
copyDir(path.join(REPO, 'skills', 'visualize-session', 'assets'), path.join(OUT, 'assets'))

console.log('bundle listo →', path.relative(HERE, OUT))
console.log('  core/, sdk/, assets/ copiados. La extensión los usará en el .vsix.')
