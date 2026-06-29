/**
 * Adaptador: opencode  (https://opencode.ai)
 *
 * opencode guarda su estado en SQLite: ~/.local/share/opencode/opencode.db
 * (respeta XDG_DATA_HOME). Tablas relevantes:
 *   - session(id, slug, title, directory, model, tokens_*, time_created, time_updated)
 *   - message(id, session_id, time_created, data)   data: {role, tokens{...}, modelID, …}
 *   - part(id, message_id, session_id, time_created, data)  data.type ∈
 *       text | reasoning | tool | step-start | step-finish
 *
 * Mapeo a la Traza Canónica (core/trace-schema.md):
 *   text(user|assistant) → message · reasoning → thinking · tool → tool_call
 *   step-start/step-finish se omiten (marcadores internos).
 *   Los tokens del turno (message.data.tokens) se cuelgan UNA vez por mensaje.
 *
 * Lectura sin dependencias: usa node:sqlite (Node ≥22.5) y, si no está (p.ej. el
 * host de extensiones con Node 20), cae al binario `sqlite3` con salida -json.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

const MAX_IO = 8000

// ---------------------------------------------------------------------------
// Lectura SQLite (node:sqlite → fallback sqlite3 CLI)
// ---------------------------------------------------------------------------
async function queryAll(dbFile, sql) {
  let DatabaseSync = null
  try {
    DatabaseSync = (await import('node:sqlite')).DatabaseSync
  } catch {
    /* sin node:sqlite */
  }
  if (DatabaseSync) {
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      return db.prepare(sql).all()
    } finally {
      db.close()
    }
  }
  // fallback: binario sqlite3 (preinstalado en macOS/muchas distros)
  const out = execFileSync('sqlite3', ['-readonly', '-json', dbFile, sql], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  return out.trim() ? JSON.parse(out) : []
}

const qstr = s => `'${String(s).replace(/'/g, "''")}'`

function dbPath(opts = {}) {
  if (opts.db) return opts.db
  if (opts.session && opts.session.endsWith('.db')) return opts.session
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(xdg, 'opencode', 'opencode.db')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseSince(s) {
  if (!s) return null
  const m = /^(\d+)([dh])$/.exec(s)
  if (m) return Date.now() - parseInt(m[1], 10) * (m[2] === 'd' ? 86400000 : 3600000)
  const d = Date.parse(s)
  return isNaN(d) ? null : d
}

const iso = ms => (ms ? new Date(ms).toISOString() : null)

function jparse(s, dflt = null) {
  try {
    return JSON.parse(s)
  } catch {
    return dflt
  }
}

function truncate(v) {
  const s = typeof v === 'string' ? v : v == null ? null : JSON.stringify(v, null, 2)
  if (s == null) return { value: null, truncated: false }
  return s.length > MAX_IO ? { value: s.slice(0, MAX_IO), truncated: true } : { value: s, truncated: false }
}

// Recorta cadenas largas conservando la forma (input estructurado legible en el visor).
function clip(v, maxStr = 4000, depth = 0) {
  if (v == null) return v
  if (typeof v === 'string') return v.length > maxStr ? v.slice(0, maxStr) + '…[recortado]' : v
  if (Array.isArray(v)) return depth > 4 ? '[…]' : v.slice(0, 60).map(x => clip(x, maxStr, depth + 1))
  if (typeof v === 'object') {
    if (depth > 6) return '{…}'
    const o = {}
    for (const k of Object.keys(v).slice(0, 60)) o[k] = clip(v[k], maxStr, depth + 1)
    return o
  }
  return v
}

// tokens de opencode {total,input,output,reasoning,cache:{read,write}} → canónico
function normTokens(t) {
  if (!t) return null
  const input = t.input || 0
  const output = t.output || 0
  const cacheRead = (t.cache && t.cache.read) || 0
  const cacheCreate = (t.cache && t.cache.write) || 0
  return { input, output, cacheRead, cacheCreate, total: t.total || input + output + cacheRead + cacheCreate }
}

function modelId(modelField) {
  // session.model es un JSON string {"id":..,"providerID":..}; message trae modelID
  const m = typeof modelField === 'string' ? jparse(modelField, null) : modelField
  if (!m) return null
  const id = m.id || m.modelID
  return m.providerID ? `${m.providerID}/${id}` : id || null
}

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------
async function listSessions(opts = {}) {
  const file = dbPath(opts)
  if (!fs.existsSync(file)) return []
  const since = parseSince(opts.since)
  const rows = await queryAll(
    file,
    `select id, slug, title, directory, tokens_input, tokens_output, tokens_cache_read,
            tokens_cache_write, time_created, time_updated
     from session order by time_updated desc`,
  )
  return rows
    .filter(r => !since || (r.time_updated || 0) >= since)
    .map(r => ({
      sessionId: r.id,
      project: path.basename(r.directory || ''),
      file,
      cwd: r.directory || null,
      title: r.title || r.slug || r.id,
      startedAt: iso(r.time_created),
      endedAt: iso(r.time_updated),
      tokens:
        (r.tokens_input || 0) + (r.tokens_output || 0) + (r.tokens_cache_read || 0) + (r.tokens_cache_write || 0),
    }))
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------
async function parse(opts = {}) {
  const file = dbPath(opts)
  if (!fs.existsSync(file)) throw new Error(`No encontré la DB de opencode: ${file}`)

  // resolver sesión: id explícito, o la más reciente
  let sessionId = opts.session && !opts.session.endsWith('.db') ? opts.session : null
  const srows = await queryAll(
    file,
    sessionId
      ? `select * from session where id=${qstr(sessionId)} limit 1`
      : `select * from session order by time_updated desc limit 1`,
  )
  const sess = srows[0]
  if (!sess) throw new Error(`No encontré la sesión opencode: ${opts.session || '(la más reciente)'}`)
  sessionId = sess.id

  // mensajes (rol + tokens por turno) y parts (contenido), en orden cronológico
  const msgs = await queryAll(
    file,
    `select id, data from message where session_id=${qstr(sessionId)}`,
  )
  const msgMap = new Map(msgs.map(m => [m.id, jparse(m.data, {})]))
  const parts = await queryAll(
    file,
    `select message_id, time_created, data from part
     where session_id=${qstr(sessionId)} order by time_created, id`,
  )

  const models = new Set()
  if (modelId(sess.model)) models.add(modelId(sess.model))
  const steps = []
  const attached = new Set() // tokens colgados 1 vez por mensaje
  let idx = 0

  for (const p of parts) {
    const d = jparse(p.data, {})
    const msg = msgMap.get(p.message_id) || {}
    const role = msg.role || 'assistant'
    const ts = iso(p.time_created)
    const mId = modelId(msg.modelID ? { id: msg.modelID, providerID: msg.providerID } : null)
    if (mId) models.add(mId)

    let step = null
    if (d.type === 'text') {
      const text = (d.text || '').trim()
      if (!text) continue
      step = { timestamp: ts, kind: 'message', role, label: role === 'user' ? 'prompt del usuario' : 'respuesta', text }
    } else if (d.type === 'reasoning') {
      const text = (d.text || '').trim()
      if (!text) continue
      step = { timestamp: ts, kind: 'thinking', role: 'assistant', label: 'razonamiento', text }
    } else if (d.type === 'tool') {
      const st = d.state || {}
      const out = truncate(st.output)
      step = {
        timestamp: ts,
        kind: 'tool_call',
        role: 'assistant',
        label: `tool:${d.tool || '?'}`,
        io: { input: clip(st.input), output: out.value, isError: st.status === 'error' },
      }
      if (out.truncated) step.io.truncated = true
    } else {
      continue // step-start / step-finish
    }

    if (role === 'assistant' && msg.tokens && !attached.has(p.message_id)) {
      step.tokens = normTokens(msg.tokens)
      attached.add(p.message_id)
    }
    step.index = idx++
    step.flags = []
    steps.push(step)
  }

  return {
    schemaVersion: 1,
    source: 'opencode',
    sessionId,
    title: sess.title || sess.slug || sessionId,
    cwd: sess.directory || null,
    startedAt: iso(sess.time_created),
    endedAt: iso(sess.time_updated),
    models: [...models],
    steps,
  }
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------
function detect(opts = {}) {
  if (opts.source === 'opencode' || opts.adapter === 'opencode') return true
  const s = opts.session
  if (s && s.endsWith('.db')) {
    try {
      return fs.existsSync(s)
    } catch {
      return false
    }
  }
  // ids de opencode: ses_… → existe la DB?
  if (s && /^ses_/.test(s)) {
    try {
      return fs.existsSync(dbPath(opts))
    } catch {
      return false
    }
  }
  return false
}

export default { name: 'opencode', detect, parse, listSessions }
