/**
 * Adaptador: VS Code Chat / GitHub Copilot
 *
 * VS Code y Copilot dejan DOS rastros de una sesión de chat (mismo sessionId):
 *
 *  A) VS Code persiste la sesión del PANEL como SNAPSHOT+PATCH:
 *     <userData>/User/workspaceStorage/<hash>/chatSessions/<id>.jsonl  (y emptyWindow…)
 *     Línea kind:0 = snapshot { v:{ version, creationDate, sessionId, requests:[],
 *     inputState.selectedModel.metadata{ vendor, family … } } }; kind:1/2 = patch
 *     { k:[keyPath], v } (kind:2 setea arrays, p.ej. requests[]/response[]). Al
 *     COMPLETAR la sesión, requests[] trae: message.text (PROMPT del usuario),
 *     response[] (thinking + markdown final + inlineReferences) y TOKENS
 *     (promptTokens/completionTokens). Vacío mientras la sesión está viva.
 *
 *  B) Copilot escribe además un TRANSCRIPTO de eventos (rico, en tiempo real):
 *     <userData>/User/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<id>.jsonl
 *     JSONL plano: session.start | assistant.message (content + reasoningText +
 *     toolRequests) | assistant.turn_start/end | tool.execution_start (arguments) |
 *     tool.execution_complete (success). Aporta el TRABAJO AGÉNTICO intermedio.
 *
 * parse() FUSIONA ambos: prompt + respuesta final + tokens (A) y razonamiento +
 * ejecución de herramientas (B). Si A aún no se volcó (sesión viva), usa solo B.
 *
 * Se llama "vscode-chat" (alias `copilot`/`vscode`) porque el almacén es de VS Code
 * y cubre cualquier modelo del chat; el transcripto rico hoy lo produce Copilot
 * (producer:"copilot-agent"). Límite: no se guarda el contenido de SALIDA de cada
 * tool (solo éxito/fallo).
 *
 * Rutas: macOS ~/Library/Application Support/<Variante>; Linux ~/.config/<Variante>;
 * Windows %APPDATA%/<Variante>. Variantes: Code, Code - Insiders, VSCodium.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

const MAX_IO = 8000

// ---------------------------------------------------------------------------
// Helpers de lectura / recorte (mismos que claude-code, para render legible)
// ---------------------------------------------------------------------------
function readLines(file) {
  const out = []
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* línea corrupta: ignorar */
    }
  }
  return out
}

function firstLine(file) {
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n').find(l => l.trim())
    return first ? JSON.parse(first) : null
  } catch {
    return null
  }
}

function safeStringify(v) {
  if (v == null) return null
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function truncate(v) {
  const s = typeof v === 'string' ? v : safeStringify(v)
  if (s == null) return { value: null, truncated: false }
  if (s.length > MAX_IO) return { value: s.slice(0, MAX_IO), truncated: true }
  return { value: s, truncated: false }
}

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

function iso(ms) {
  if (ms == null) return null
  const n = typeof ms === 'number' ? ms : Date.parse(ms)
  if (isNaN(n)) return null
  return new Date(n).toISOString()
}

function parseSince(s) {
  if (!s) return null
  const m = /^(\d+)([dh])$/.exec(s)
  if (m) {
    const unit = m[2] === 'd' ? 86400000 : 3600000
    return Date.now() - parseInt(m[1], 10) * unit
  }
  const d = Date.parse(s)
  return isNaN(d) ? null : d
}

function safeExists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Localización de los almacenes de chat (por SO y variante de editor)
// ---------------------------------------------------------------------------
const VARIANTS = ['Code', 'Code - Insiders', 'VSCodium', 'VSCodium - Insiders']

function userDataRoots() {
  const home = os.homedir()
  let bases = []
  if (process.platform === 'darwin') {
    bases = VARIANTS.map(v => path.join(home, 'Library', 'Application Support', v))
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    bases = VARIANTS.map(v => path.join(appData, v))
  } else {
    const cfg = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
    bases = VARIANTS.map(v => path.join(cfg, v))
  }
  return bases.map(b => path.join(b, 'User')).filter(p => safeExists(p))
}

// Genera { file, hash } de cada sesión de chat del panel en todos los almacenes.
function* chatFiles(opts = {}) {
  const roots = opts.dir ? [opts.dir] : userDataRoots()
  for (const userDir of roots) {
    const wsRoot = path.join(userDir, 'workspaceStorage')
    let hashes
    try {
      hashes = fs.readdirSync(wsRoot, { withFileTypes: true })
    } catch {
      hashes = []
    }
    for (const h of hashes) {
      if (!h.isDirectory()) continue
      for (const f of jsonlIn(path.join(wsRoot, h.name, 'chatSessions'))) yield { file: f, hash: h.name }
    }
    for (const f of jsonlIn(path.join(userDir, 'globalStorage', 'emptyWindowChatSessions'))) {
      yield { file: f, hash: null }
    }
  }
}

function jsonlIn(dir) {
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }
  return files.filter(n => n.endsWith('.jsonl')).map(n => path.join(dir, n))
}

// cwd/proyecto desde el workspace.json hermano (<hash>/workspace.json)
function workspaceInfo(file, hash) {
  if (!hash) return { project: null, cwd: null }
  try {
    const wsDir = hashDirOf(file, hash)
    const wj = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf8'))
    const uri = wj.folder || wj.workspace || null
    if (!uri) return { project: null, cwd: null }
    let p = uri
    try {
      p = decodeURIComponent(uri.replace(/^file:\/\//, ''))
    } catch {
      /* deja la uri cruda */
    }
    return { project: path.basename(p) || null, cwd: p || null }
  } catch {
    return { project: null, cwd: null }
  }
}

// Directorio <hash> (workspaceStorage/<hash>) a partir de cualquier archivo dentro.
function hashDirOf(file) {
  const parts = file.split(path.sep)
  const i = parts.lastIndexOf('workspaceStorage')
  if (i >= 0 && parts[i + 1]) return parts.slice(0, i + 2).join(path.sep)
  return null
}

function hashFromPath(file) {
  const parts = file.split(path.sep)
  const i = parts.lastIndexOf('workspaceStorage')
  return i >= 0 && parts[i + 1] ? parts[i + 1] : null
}

// Transcripto de Copilot para un sessionId (si existe en el mismo <hash>).
function copilotTranscriptFor(anyFileInHash, sessionId) {
  const wsDir = hashDirOf(anyFileInHash)
  if (!wsDir) return null
  const t = path.join(wsDir, 'GitHub.copilot-chat', 'transcripts', `${sessionId}.jsonl`)
  return safeExists(t) ? t : null
}

// El chatSessions hermano de un transcripto (para metadatos: modelo/fecha).
function chatSessionsFor(transcriptFile, sessionId) {
  const wsDir = hashDirOf(transcriptFile)
  if (!wsDir) return null
  const c = path.join(wsDir, 'chatSessions', `${sessionId}.jsonl`)
  return safeExists(c) ? c : null
}

// ---------------------------------------------------------------------------
// Reconstrucción del snapshot+patch (chatSessions)
// ---------------------------------------------------------------------------
function setAtPath(root, keypath, value) {
  if (!Array.isArray(keypath) || keypath.length === 0) return
  let node = root
  for (let i = 0; i < keypath.length - 1; i++) {
    const key = keypath[i]
    const next = keypath[i + 1]
    if (node[key] == null || typeof node[key] !== 'object') {
      node[key] = typeof next === 'number' ? [] : {}
    }
    node = node[key]
  }
  node[keypath[keypath.length - 1]] = value
}

function reconstruct(lines) {
  let session = null
  for (const o of lines) {
    if (!o || typeof o !== 'object') continue
    if (o.kind === 0) {
      session = o.v ? JSON.parse(JSON.stringify(o.v)) : {}
      continue
    }
    if (session == null) continue
    // kind:1 (set escalar) y kind:2 (set/replace de arrays, p.ej. requests[],
    // response[]) son ambos "set en key-path". Tratamos cualquier patch con `k`
    // de array como un set; kinds desconocidos se ignoran (degradación).
    if (Array.isArray(o.k)) {
      try {
        setAtPath(session, o.k, o.v)
      } catch {
        /* patch malformado: ignorar */
      }
    }
  }
  return session
}

function modelIdOf(meta) {
  if (!meta || typeof meta !== 'object') return null
  const vendor = meta.vendor || null
  const fam = meta.family || meta.id || meta.name || null
  if (vendor && fam) return `${vendor}/${fam}`
  return fam || vendor || null
}

const selectedModelMeta = s => s?.inputState?.selectedModel?.metadata || null

function userTextOf(message) {
  if (message == null) return null
  if (typeof message === 'string') return message
  if (typeof message.text === 'string') return message.text
  if (Array.isArray(message.parts)) {
    return message.parts.map(p => (typeof p === 'string' ? p : p?.text || p?.value || '')).filter(Boolean).join('\n') || null
  }
  return null
}

function firstUserText(session) {
  const reqs = Array.isArray(session?.requests) ? session.requests.filter(Boolean) : []
  for (const r of reqs) {
    const t = userTextOf(r?.message)
    if (t) return t
  }
  return null
}

// ---------------------------------------------------------------------------
// Parseo del TRANSCRIPTO de Copilot (event stream)  → steps canónicos
// ---------------------------------------------------------------------------
function isCopilotTranscript(file) {
  const o = firstLine(file)
  return !!(o && typeof o.type === 'string' && o.data && (o.type === 'session.start' || o.type.startsWith('assistant.') || o.type.startsWith('tool.')))
}

function parseCopilotTranscript(file) {
  const events = readLines(file)
  const steps = []
  const toolStepById = new Map()
  let idx = 0
  let turn = 0
  let sessionId = null
  let startTime = null
  let copilotVersion = null
  let firstAssistant = null
  let lastTs = null

  const push = s => {
    s.index = idx++
    s.flags = s.flags || []
    steps.push(s)
    return s
  }

  for (const e of events) {
    if (!e || typeof e !== 'object') continue
    const d = e.data || {}
    const ts = e.timestamp || null
    if (ts) lastTs = ts
    switch (e.type) {
      case 'session.start':
        sessionId = d.sessionId || sessionId
        startTime = d.startTime || startTime
        copilotVersion = d.copilotVersion || copilotVersion
        break
      case 'assistant.message': {
        turn++
        const reasoning = (d.reasoningText || '').trim()
        if (reasoning) {
          const tr = truncate(reasoning)
          push({
            timestamp: ts,
            kind: 'thinking',
            role: 'assistant',
            label: 'razonamiento',
            text: tr.value,
            turn,
            io: tr.truncated ? { truncated: true } : null,
          })
        }
        const content = (d.content || '').trim()
        if (content) {
          if (firstAssistant == null) firstAssistant = content
          const tr = truncate(content)
          push({
            timestamp: ts,
            kind: 'message',
            role: 'assistant',
            label: 'respuesta',
            text: tr.value,
            turn,
            io: tr.truncated ? { truncated: true } : null,
          })
        }
        break
      }
      case 'tool.execution_start': {
        const name = d.toolName || 'tool'
        const step = push({
          timestamp: ts,
          kind: 'tool_call',
          role: 'assistant',
          label: `tool:${name}`,
          turn: turn || 1,
          io: { input: d.arguments == null ? null : clip(d.arguments) },
          raw: { toolCallId: d.toolCallId },
        })
        if (d.toolCallId) toolStepById.set(d.toolCallId, step)
        break
      }
      case 'tool.execution_complete': {
        const step = toolStepById.get(d.toolCallId)
        if (step) {
          step.io = step.io || {}
          step.io.isError = d.success === false
          const out = d.output ?? d.result ?? null
          if (out != null) {
            const tr = truncate(out)
            step.io.output = tr.value
            if (tr.truncated) step.io.truncated = true
          }
        }
        break
      }
      // assistant.turn_start/turn_end y otros: solo marcan límites; los ignoramos
      default:
        break
    }
  }

  return { steps, sessionId, startTime, copilotVersion, firstAssistant, lastTs }
}

// ---------------------------------------------------------------------------
// listSessions  (lista el panel; enriquece desde el transcripto si existe)
// ---------------------------------------------------------------------------
async function listSessions(opts = {}) {
  const since = parseSince(opts.since)
  const rows = []
  for (const { file, hash } of chatFiles(opts)) {
    const session = reconstruct(readLines(file))
    if (!session) continue
    const sessionId = session.sessionId || path.basename(file, '.jsonl')
    let mtime = null
    try {
      mtime = fs.statSync(file).mtimeMs
    } catch {
      /* sin stat */
    }
    // si hay transcripto de Copilot, su mtime suele ser más fresco y tiene contenido
    const transcript = hash ? copilotTranscriptFor(file, sessionId) : null
    let transMeta = null
    if (transcript) {
      try {
        mtime = Math.max(mtime || 0, fs.statSync(transcript).mtimeMs)
      } catch {
        /* sin stat */
      }
    }
    const endedMs = mtime || session.creationDate || null
    if (since && (endedMs == null || endedMs < since)) continue
    const { project, cwd } = workspaceInfo(file, hash)
    const reqs = Array.isArray(session.requests) ? session.requests.filter(Boolean) : []
    let title = firstUserText(session)
    let requestCount = reqs.length
    // tokens: Copilot los reporta por request en chatSessions (al completar)
    const tokens = reqs.reduce((a, r) => a + (Number(r.promptTokens) || 0) + (Number(r.completionTokens) || 0), 0)
    if (transcript && (!title || !requestCount)) {
      transMeta = parseCopilotTranscript(transcript)
      requestCount = requestCount || transMeta.steps.filter(s => s.kind === 'message' && s.role === 'assistant').length
      if (!title && transMeta.firstAssistant) title = transMeta.firstAssistant
    }
    rows.push({
      sessionId,
      source: 'vscode-chat',
      file,
      project,
      cwd,
      title: title ? title.slice(0, 80) : null,
      startedAt: iso(session.creationDate),
      endedAt: iso(endedMs),
      tokens,
      model: modelIdOf(selectedModelMeta(session)),
      requestCount,
      hasTranscript: !!transcript,
    })
  }
  rows.sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''))
  return rows
}

// ---------------------------------------------------------------------------
// parse → Traza Canónica
// ---------------------------------------------------------------------------
// Resuelve a { transcript, chatSessions, sessionId } a partir de opts.session/file
// (ruta a un transcripto, a un chatSessions, o un id pelado).
function resolveSession(opts) {
  const sess = opts.session || opts.file
  if (sess && sess.endsWith('.jsonl') && safeExists(sess)) {
    if (isCopilotTranscript(sess)) {
      const id = path.basename(sess, '.jsonl')
      return { transcript: sess, chatSessions: chatSessionsFor(sess, id), sessionId: id }
    }
    // chatSessions
    const snap = firstLine(sess)
    const id = snap?.v?.sessionId || path.basename(sess, '.jsonl')
    return { transcript: copilotTranscriptFor(sess, id), chatSessions: sess, sessionId: id }
  }
  if (sess) {
    const id = sess.endsWith('.jsonl') ? path.basename(sess, '.jsonl') : sess
    for (const ent of chatFiles(opts)) {
      if (path.basename(ent.file, '.jsonl') === id) {
        return { transcript: copilotTranscriptFor(ent.file, id), chatSessions: ent.file, sessionId: id }
      }
    }
  }
  return null
}

// Etiqueta corta de una inlineReference (un archivo citado dentro del markdown).
function refLabel(ref) {
  const p = ref && (ref.fsPath || ref.path || ref.external || (ref.uri && (ref.uri.fsPath || ref.uri.path)))
  if (!p) return null
  const base = String(p).replace(/[/\\]+$/, '').split(/[/\\]/).pop()
  return base || null
}

// Descompone el response[] de una request de chatSessions en: razonamiento,
// herramientas, y el texto final (markdown concatenado + nombres de archivos
// citados inline). Tolera formas desconocidas (degrada a texto).
function responseParts(r) {
  const parts = Array.isArray(r.response) ? r.response : r.response ? [r.response] : []
  const thinkings = []
  const tools = []
  let answer = ''
  for (const p of parts) {
    if (p == null) continue
    if (typeof p === 'string') {
      answer += p
      continue
    }
    const kind = p.kind
    if (kind === 'thinking') {
      if ((p.value || '').trim()) thinkings.push(p.value)
    } else if (kind === 'inlineReference') {
      const l = refLabel(p.inlineReference)
      if (l) answer += '`' + l + '`'
    } else if (kind === 'toolInvocationSerialized' || p.toolId || p.toolName || (kind && /tool/i.test(kind))) {
      tools.push({ name: p.toolName || p.toolId || 'tool', input: p.toolInput ?? p.toolSpecificData ?? p.input ?? null, isError: !!p.isError })
    } else if (typeof p.value === 'string') {
      answer += p.value
    } else if (typeof p.text === 'string') {
      answer += p.text
    }
  }
  return { thinkings, tools, answer: answer.trim() }
}

// Tokens de una request (Copilot SÍ los reporta en chatSessions, al completar).
function requestTokens(r) {
  const input = Number(r.promptTokens) || 0
  const output = Number(r.completionTokens) || 0
  if (!input && !output) return null
  return { input, output, cacheRead: 0, cacheCreate: 0, total: input + output }
}

async function parse(opts = {}) {
  const res = resolveSession(opts)
  if (!res) throw new Error(`No encontré la sesión vscode-chat/copilot: ${opts.session || opts.file}`)

  // chatSessions (panel): metadatos + prompt del usuario + respuesta final + tokens
  // (se llena al completar la sesión). Transcripto de Copilot: el trabajo agéntico
  // intermedio (razonamiento + ejecución de herramientas). Se FUSIONAN.
  const snapshot = res.chatSessions ? reconstruct(readLines(res.chatSessions)) : null
  const anchorFile = res.chatSessions || res.transcript
  const { cwd } = workspaceInfo(anchorFile, hashFromPath(anchorFile))
  const models = new Set()
  const selModel = modelIdOf(selectedModelMeta(snapshot || {}))
  if (selModel) models.add(selModel)

  const transcriptParsed = res.transcript ? parseCopilotTranscript(res.transcript) : null
  const transcriptSteps = transcriptParsed ? transcriptParsed.steps : []
  const reqs = Array.isArray(snapshot?.requests) ? snapshot.requests.filter(Boolean) : []

  let steps = []
  let idx = 0
  const push = s => {
    s.index = idx++
    s.flags = s.flags || []
    steps.push(s)
    return s
  }

  let startedMs, lastTs, title
  if (reqs.length) {
    reqs.forEach((r, i) => {
      const turn = i + 1
      // 1) prompt del usuario
      const utext = userTextOf(r.message)
      if (utext != null) {
        const tr = truncate(utext)
        push({ timestamp: null, kind: 'message', role: 'user', label: 'prompt del usuario', text: tr.value, turn, io: tr.truncated ? { truncated: true } : null })
      }
      // 2) trabajo agéntico: del transcripto (razonamiento + tools reales) en la
      //    primera request; si no hay transcripto, de las partes del response.
      const { thinkings, tools, answer } = responseParts(r)
      if (i === 0 && transcriptSteps.length) {
        for (const st of transcriptSteps) push({ ...st })
      } else {
        for (const th of thinkings) {
          const tr = truncate(th.trim())
          if (tr.value) push({ timestamp: null, kind: 'thinking', role: 'assistant', label: 'razonamiento', text: tr.value, turn, io: tr.truncated ? { truncated: true } : null })
        }
        for (const tl of tools) {
          push({ timestamp: null, kind: 'tool_call', role: 'assistant', label: `tool:${tl.name}`, turn, io: { input: tl.input == null ? null : clip(tl.input), isError: tl.isError } })
        }
      }
      // 3) respuesta final + tokens del turno
      const tok = requestTokens(r)
      const model = r.modelId || selModel || null
      if (model) models.add(model)
      if (answer) {
        const tr = truncate(answer)
        push({ timestamp: null, kind: 'message', role: 'assistant', label: 'respuesta', text: tr.value, turn, model, tokens: tok, io: tr.truncated ? { truncated: true } : null })
      } else if (tok) {
        // sin texto final pero con tokens: cuélgalos del último paso del turno
        const last = steps[steps.length - 1]
        if (last && !last.tokens) last.tokens = tok
      }
    })
    startedMs = snapshot?.creationDate ?? (transcriptParsed?.startTime ? Date.parse(transcriptParsed.startTime) : null)
    lastTs = transcriptParsed?.lastTs || null
    title = firstUserText(snapshot) || transcriptParsed?.firstAssistant || null
  } else if (transcriptSteps.length) {
    // sesión viva: el chatSessions aún no se volcó; muestra el transcripto.
    steps = transcriptSteps
    startedMs = snapshot?.creationDate ?? (transcriptParsed?.startTime ? Date.parse(transcriptParsed.startTime) : null)
    lastTs = transcriptParsed?.lastTs
    title = transcriptParsed?.firstAssistant || null
    if (selModel == null && transcriptParsed?.copilotVersion) models.add(`copilot/${transcriptParsed.copilotVersion}`)
  } else {
    startedMs = snapshot?.creationDate ?? null
    title = firstUserText(snapshot || {})
  }

  let mtime = null
  try {
    mtime = fs.statSync(res.transcript || res.chatSessions).mtimeMs
  } catch {
    /* sin stat */
  }

  return {
    schemaVersion: 1,
    source: 'vscode-chat',
    sessionId: res.sessionId || snapshot?.sessionId || 'vscode-chat',
    title: title ? title.slice(0, 80) : null,
    cwd,
    startedAt: iso(startedMs),
    endedAt: lastTs || iso(mtime),
    models: [...models],
    steps,
  }
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------
function looksLikeVscodeChat(file) {
  const o = firstLine(file)
  if (o && o.kind === 0 && o.v && (o.v.sessionId || o.v.responderUsername) && Array.isArray(o.v.requests)) return true
  return isCopilotTranscript(file)
}

function detect(opts = {}) {
  const w = opts.adapter || opts.source
  if (w === 'vscode-chat' || w === 'copilot' || w === 'vscode' || w === 'vs-code') return true
  const sess = opts.session || opts.file
  if (sess) {
    if (sess.endsWith('.jsonl')) return safeExists(sess) && looksLikeVscodeChat(sess)
    if (sess.endsWith('.ndjson') || sess.endsWith('.json')) return false
    return resolveSession(opts) != null
  }
  return userDataRoots().length > 0
}

export default { name: 'vscode-chat', detect, parse, listSessions }
