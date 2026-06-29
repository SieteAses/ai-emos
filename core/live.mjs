/**
 * core/live.mjs — observación en vivo de una sesión.
 *
 * Pieza COMPARTIDA por el servidor (skills/.../server.mjs, con SSE) y la
 * extensión de VS Code (extension.js, con postMessage). Observa el/los
 * archivo(s) de una sesión, y en cada cambio re-parsea con el adaptador +
 * `enrich` y entrega la traza fresca por callback (con debounce).
 *
 * El watcher es INYECTABLE: por defecto usa `fs.watch` nativo (cero deps), pero
 * el servidor puede pasar uno basado en `chokidar` si está instalado. Así la
 * extensión queda sin dependencias y `core/` permanece puro.
 */

import fs from 'fs'
import path from 'path'
import adapters from './adapters/index.mjs'
import { enrich } from './render.mjs'
import { loadCriteria, loadBaselines } from './criteria.mjs'

// Clave estable de un finding ("tramo a revisar") para detectar cuáles son
// NUEVOS entre dos snapshots de la misma sesión. Como el JSONL es append-only,
// el índice del paso y su ruta de anidamiento se mantienen, así que el mismo
// hallazgo produce la misma clave en re-parseos sucesivos.  separa campos
// (no aparece en rutas/labels) para evitar colisiones por concatenación.
export function findingKey(f) {
  return [f.path || '', f.index ?? '', f.kind || '', f.label || '', (f.flags || []).join('|')].join('')
}

const traceFindings = trace => (trace && trace.summary && trace.summary.findings) || []

// Watcher por defecto: fs.watch sobre cada ruta (archivo o directorio).
// macOS/Windows soportan `recursive` para directorios; en Linux observa el
// directorio de primer nivel (suficiente para subagents/ que es plano).
export function defaultWatcher(paths, onChange) {
  const watchers = []
  for (const p of paths) {
    try {
      const recursive = fs.statSync(p).isDirectory()
      watchers.push(fs.watch(p, { recursive }, () => onChange()))
    } catch {
      /* ruta inexistente o no observable: se ignora */
    }
  }
  return () => {
    for (const w of watchers) {
      try {
        w.close()
      } catch {
        /* noop */
      }
    }
  }
}

// Firma barata del contenido observado (tamaño + mtime de cada ruta; para
// directorios, de sus entradas directas — los subagentes viven planos ahí).
// fs.watch/chokidar disparan eventos ESPURIOS (metadata, atime, varias rutas
// por un solo cambio); comparar la firma evita re-parsear el JSONL entero
// cuando nada cambió de verdad. Es la optimización segura y agnóstica al
// adaptador (los adaptadores correlacionan todo el archivo y no admiten un
// parse incremental por offset sin reescribirlos).
function fingerprint(paths) {
  let sig = ''
  for (const p of paths) {
    try {
      const st = fs.statSync(p)
      if (st.isDirectory()) {
        for (const name of fs.readdirSync(p).sort()) {
          try {
            const f = fs.statSync(path.join(p, name))
            if (f.isFile()) sig += name + ':' + f.size + ':' + f.mtimeMs + '|'
          } catch {
            /* entrada desaparecida entre readdir y stat */
          }
        }
      } else {
        sig += p + ':' + st.size + ':' + st.mtimeMs + '|'
      }
    } catch {
      /* ruta inexistente: se omite */
    }
  }
  return sig
}

// Deriva las rutas a observar a partir del archivo de la sesión: el propio
// archivo + carpetas hermanas de sub-agentes/workflows si existen.
function resolveWatchPaths(file) {
  const out = new Set()
  if (!file || !fs.existsSync(file)) return []
  out.add(file)
  const dir = path.dirname(file)
  const sid = path.basename(file).replace(/\.[^.]+$/, '')
  const sidDir = path.join(dir, sid)
  if (fs.existsSync(sidDir)) out.add(sidDir) // layout <dir>/<sid>/{subagents,workflows}
  return [...out]
}

// Resuelve el archivo de la sesión: el dado, o el de la fila de listSessions.
async function resolveFile(opts) {
  if (opts.file && fs.existsSync(opts.file)) return opts.file
  if (typeof opts.session === 'string' && /[\\/.]/.test(opts.session) && fs.existsSync(opts.session)) {
    return opts.session
  }
  try {
    const rows = await adapters.listSessions(opts)
    const row = rows.find(r => r.sessionId === opts.session)
    if (row && row.file) return row.file
  } catch {
    /* el adaptador puede no listar; seguimos sin rutas (solo estado inicial) */
  }
  return null
}

/**
 * watchSession(opts, onUpdate, cfg) → closeFn
 *
 * opts: { session|file, adapter|source, criteria?, baselines? }
 * onUpdate(trace, { newFindings }): se llama con la traza enriquecida en cada
 *   cambio. `newFindings` son los tramos a revisar que APARECIERON en este
 *   cambio (no estaban en el snapshot previo) — la base del feed en vivo. El
 *   estado inicial se usa como línea base: emite `newFindings: []` para no
 *   notificar tramos ya presentes al abrir.
 * cfg.watcher(paths, onChange) → closeFn   (inyectable; def. defaultWatcher)
 * cfg.debounceMs (def. 250)
 *
 * Emite el estado inicial inmediatamente; devuelve una función para cerrar.
 */
export async function watchSession(opts, onUpdate, { watcher = defaultWatcher, debounceMs = 250 } = {}) {
  const criteria = opts.criteria || loadCriteria()
  const baselines = opts.baselines || loadBaselines()
  let timer = null
  let closing = false
  const seen = new Set() // claves de findings ya vistos
  let primed = false // el primer snapshot solo siembra la línea base
  let watchPaths = [] // rutas observadas (para el fingerprint)
  let lastSig = null // firma del último contenido parseado

  const reparse = async () => {
    try {
      // salta el re-parse completo si el contenido observado no cambió (eventos
      // espurios de fs.watch). En el 1er snapshot (primed=false) siempre parsea.
      if (primed && watchPaths.length) {
        const sig = fingerprint(watchPaths)
        if (sig === lastSig) return
        lastSig = sig
      }
      const trace = enrich(await adapters.parse(opts), { criteria, baselines })
      if (closing) return
      const findings = traceFindings(trace)
      const newFindings = []
      for (const f of findings) {
        const k = findingKey(f)
        if (seen.has(k)) continue
        seen.add(k)
        if (primed) newFindings.push(f) // en el 1er snapshot solo sembramos
      }
      primed = true
      onUpdate(trace, { newFindings })
    } catch {
      /* archivo a medio escribir: ignora; el siguiente evento reintenta */
    }
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(reparse, debounceMs)
  }

  await reparse() // estado inicial

  const file = await resolveFile(opts)
  watchPaths = resolveWatchPaths(file)
  lastSig = fingerprint(watchPaths) // línea base: descarta eventos espurios sin cambio
  const close = watchPaths.length ? watcher(watchPaths, schedule) : () => {}

  return () => {
    closing = true
    clearTimeout(timer)
    try {
      close()
    } catch {
      /* noop */
    }
  }
}

export default { watchSession, defaultWatcher, findingKey }
