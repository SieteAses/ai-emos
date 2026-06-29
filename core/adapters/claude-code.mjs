/**
 * Adaptador: Claude Code  (fuente primaria)
 *
 * Convierte los transcripts JSONL de ~/.claude/projects/<project>/<sessionId>.jsonl
 * (+ subagentes en <sessionId>/subagents/agent-<id>.jsonl, con sibling *.meta.json)
 * a una Traza Canónica (ver core/trace-schema.md).
 *
 * Estructura JSONL descubierta empíricamente y validada contra la skill oficial
 * `session-report` (analyze-sessions.mjs):
 *  - assistant: message.content[] con bloques thinking|text|tool_use; message.usage
 *    con tokens. Una respuesta puede partirse en varias entradas assistant que
 *    comparten requestId; solo la última trae el output_tokens final.
 *  - user: message.content[] con tool_result (tool_use_id, content, is_error) y/o
 *    texto humano. e.toolUseResult trae datos ricos (Agent: agentId/totalTokens/
 *    toolStats/durationMs; AskUserQuestion: answers).
 *  - Agent/Task tool_use → sub-agente; su transcript vive en subagents/agent-<id>.jsonl
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

const MAX_IO = 8000 // recorte de I/O por paso (la UF es self-contained)

function projectsRoot(opts = {}) {
  return opts.dir || path.join(os.homedir(), '.claude', 'projects')
}

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

function truncate(v) {
  let s = typeof v === 'string' ? v : safeStringify(v)
  if (s == null) return { value: null, truncated: false }
  if (s.length > MAX_IO) return { value: s.slice(0, MAX_IO), truncated: true }
  return { value: s, truncated: false }
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

// Recorta en profundidad las cadenas largas de un objeto, conservando su forma
// (para que el visor pueda renderizar input estructurado en vez de JSON crudo).
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

// Aplana el `content` de un tool_result (string | array de bloques) a texto.
function flattenContent(content) {
  if (content == null) return null
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(b => {
        if (typeof b === 'string') return b
        if (b && b.type === 'text') return b.text || ''
        return safeStringify(b)
      })
      .join('\n')
  }
  return safeStringify(content)
}

// ---------------------------------------------------------------------------
// Descubrimiento de sesiones
// ---------------------------------------------------------------------------
function* walkProjects(root) {
  let ents
  try {
    ents = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const proj of ents) {
    if (!proj.isDirectory()) continue
    const pdir = path.join(root, proj.name)
    let files
    try {
      files = fs.readdirSync(pdir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        yield { project: proj.name, file: path.join(pdir, f.name) }
      }
    }
  }
}

function parseSince(s) {
  if (!s) return null
  const m = /^(\d+)([dh])$/.exec(s)
  if (m) {
    const ms = m[2] === 'd' ? 86400000 : 3600000
    return Date.now() - parseInt(m[1], 10) * ms
  }
  const d = Date.parse(s)
  return isNaN(d) ? null : d
}

function quickMeta(file) {
  // Lee solo lo necesario para listar: título, primer/último ts, tokens gruesos.
  const entries = readLines(file)
  let title = null
  let firstTs = null
  let lastTs = null
  let tokens = 0
  let cwd = null
  const seenReq = new Set()
  for (const e of entries) {
    if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle
    if (e.cwd && !cwd) cwd = e.cwd
    if (e.timestamp) {
      const ts = Date.parse(e.timestamp)
      if (!isNaN(ts)) {
        if (firstTs === null) firstTs = ts
        lastTs = ts
      }
    }
    if (e.type === 'assistant' && e.message && e.message.usage) {
      const key = e.requestId || e.message.id || e.uuid
      if (key && seenReq.has(key)) continue
      if (key) seenReq.add(key)
      const u = e.message.usage
      tokens +=
        (u.input_tokens || 0) +
        (u.cache_creation_input_tokens || 0) +
        (u.cache_read_input_tokens || 0) +
        (u.output_tokens || 0)
    }
  }
  return { title, firstTs, lastTs, tokens, cwd }
}

async function listSessions(opts = {}) {
  const root = projectsRoot(opts)
  const since = parseSince(opts.since)
  const rows = []
  for (const { project, file } of walkProjects(root)) {
    const sessionId = path.basename(file, '.jsonl')
    const m = quickMeta(file)
    if (since && (m.lastTs == null || m.lastTs < since)) continue
    rows.push({
      sessionId,
      project,
      file,
      title: m.title,
      cwd: m.cwd,
      startedAt: m.firstTs ? new Date(m.firstTs).toISOString() : null,
      endedAt: m.lastTs ? new Date(m.lastTs).toISOString() : null,
      tokens: m.tokens,
    })
  }
  rows.sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''))
  return rows
}

// ---------------------------------------------------------------------------
// Resolución de archivo de sesión y mapa de sub-agentes
// ---------------------------------------------------------------------------
function resolveSessionFile(opts) {
  const sess = opts.session
  if (sess && sess.endsWith('.jsonl') && fs.existsSync(sess)) return sess
  const root = projectsRoot(opts)
  for (const { file } of walkProjects(root)) {
    if (path.basename(file, '.jsonl') === sess) return file
  }
  return null
}

function buildSubagentMap(mainFile, sessionId) {
  // agentId -> jsonl path, leyendo <dir>/<sessionId>/subagents/ y /workflows/
  const map = new Map()
  const baseDir = path.dirname(mainFile)
  for (const sub of ['subagents', 'workflows']) {
    const dir = path.join(baseDir, sessionId, sub)
    let files
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue
      const base = name.replace(/\.jsonl$/, '')
      const agentId = base.replace(/^agent-/, '')
      map.set(agentId, path.join(dir, name))
    }
  }
  return map
}

function metaAgentType(jsonlPath) {
  try {
    const m = JSON.parse(
      fs.readFileSync(jsonlPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'),
    )
    if (m && typeof m.agentType === 'string') return m.agentType
  } catch {
    /* sin meta */
  }
  return null
}

// ---------------------------------------------------------------------------
// Parseo de un transcript (recursivo para sub-agentes)
// ---------------------------------------------------------------------------
function dedupeUsageByRequest(entries) {
  // requestId -> usage con el output_tokens máximo (las primeras entradas traen
  // conteos parciales). Devuelve Map requestId -> {usage}.
  const byReq = new Map()
  for (const e of entries) {
    if (e.type !== 'assistant') continue
    const u = e.message && e.message.usage
    if (!u) continue
    const key = e.requestId || e.message.id || e.uuid
    if (!key) continue
    const prev = byReq.get(key)
    if (!prev || (u.output_tokens || 0) >= (prev.output_tokens || 0)) {
      byReq.set(key, u)
    }
  }
  return byReq
}

function normTokens(u) {
  if (!u) return null
  const input = u.input_tokens || 0
  const output = u.output_tokens || 0
  const cacheRead = u.cache_read_input_tokens || 0
  const cacheCreate = u.cache_creation_input_tokens || 0
  return {
    input,
    output,
    cacheRead,
    cacheCreate,
    total: input + output + cacheRead + cacheCreate,
  }
}

function parseTranscript(entries, ctx) {
  // ctx: { subagentMap, depth, models:Set }
  const steps = []
  const usageByReq = dedupeUsageByRequest(entries)
  const attached = new Set() // requestId ya con tokens asignados (1 vez por turno)
  const stepByToolUseId = new Map()
  let idx = 0

  const push = s => {
    s.index = idx++
    s.flags = s.flags || []
    steps.push(s)
    return s
  }

  for (const e of entries) {
    const ts = e.timestamp || null

    // ---- USER ----
    if (e.type === 'user') {
      if (e.isMeta || e.isCompactSummary) continue
      const content = e.message && e.message.content
      const tur = e.toolUseResult

      // tool_result(s): rellenar el paso correspondiente
      let handledToolResult = false
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === 'tool_result') {
            handledToolResult = true
            const step = stepByToolUseId.get(b.tool_use_id)
            const flat = flattenContent(b.content)
            const out = truncate(flat)
            if (step) {
              step.io = step.io || {}
              step.io.output = out.value
              step.io.isError = !!b.is_error
              if (out.truncated) step.io.truncated = true
              fillFromToolResult(step, tur, ctx)
            }
          }
        }
      }
      if (handledToolResult) continue

      // texto humano
      let text = null
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        const t = content.find(b => b && b.type === 'text')
        if (t) text = t.text || ''
      }
      if (text == null) continue
      if (text.startsWith('[Request interrupted')) {
        push({
          timestamp: ts,
          kind: 'event',
          label: 'interrupción del usuario',
          role: 'user',
          flags: ['interrupted'],
        })
        continue
      }
      if (
        text.startsWith('<task-notification') ||
        text.startsWith('<scheduled-wakeup') ||
        text.startsWith('<background-task')
      ) {
        continue
      }
      const slash = /<command-(?:name|message)>\/?([^<]+)<\/command-/.exec(text)
      if (slash) {
        push({
          timestamp: ts,
          kind: 'skill',
          label: `comando:/${slash[1].trim()}`,
          role: 'user',
        })
        continue
      }
      const tr = truncate(text)
      push({
        timestamp: ts,
        kind: 'message',
        role: 'user',
        label: 'prompt del usuario',
        text: tr.value,
        io: tr.truncated ? { truncated: true } : null,
      })
      continue
    }

    // ---- ASSISTANT ----
    if (e.type === 'assistant') {
      const msg = e.message || {}
      if (msg.model && ctx.models) ctx.models.add(msg.model)
      const reqKey = e.requestId || msg.id || e.uuid
      // tokens del turno: se asignan UNA sola vez por requestId, y solo cuando
      // de verdad hay un paso al que colgarlos (las entradas se parten en varias
      // y algunas no producen pasos; no debemos perder los tokens por eso).
      const turnTokens =
        reqKey && !attached.has(reqKey) && usageByReq.has(reqKey)
          ? normTokens(usageByReq.get(reqKey))
          : null
      const content = Array.isArray(msg.content) ? msg.content : []
      let assignedTokens = false
      const assign = step => {
        if (turnTokens && !assignedTokens) {
          step.tokens = turnTokens
          assignedTokens = true
          attached.add(reqKey)
        }
        return step
      }

      for (const b of content) {
        if (!b || !b.type) continue
        if (b.type === 'thinking') {
          const th = (b.thinking || '').trim()
          if (!th) continue
          const tr = truncate(th)
          assign(
            push({
              timestamp: ts,
              kind: 'thinking',
              role: 'assistant',
              label: 'razonamiento',
              text: tr.value,
              io: tr.truncated ? { truncated: true } : null,
            }),
          )
        } else if (b.type === 'text') {
          const tx = (b.text || '').trim()
          if (!tx) continue
          const tr = truncate(tx)
          assign(
            push({
              timestamp: ts,
              kind: 'message',
              role: 'assistant',
              label: 'respuesta',
              text: tr.value,
              io: tr.truncated ? { truncated: true } : null,
            }),
          )
        } else if (b.type === 'tool_use') {
          const step = toolUseToStep(b, ts)
          assign(step)
          push(step)
          if (b.id) stepByToolUseId.set(b.id, step)
        }
      }
      continue
    }
  }

  return steps
}

function toolUseToStep(b, ts) {
  const name = b.name || 'tool'
  const base = {
    timestamp: ts,
    role: 'assistant',
    // input ESTRUCTURADO (objeto con cadenas recortadas) para render legible
    io: { input: clip(b.input) },
    raw: { toolUseId: b.id },
  }
  if (name === 'Agent' || name === 'Task') {
    return {
      ...base,
      kind: 'agent',
      label: `agente:${b.input?.subagent_type || '?'}`,
      agent: {
        name: b.input?.subagent_type || null,
        id: null,
        steps: [],
        prompt: b.input?.prompt || null,
      },
    }
  }
  if (name === 'Skill') {
    return { ...base, kind: 'skill', label: `skill:${b.input?.skill || '?'}` }
  }
  if (name === 'AskUserQuestion') {
    const qs = b.input?.questions || []
    return {
      ...base,
      kind: 'decision',
      label: 'decisión humana',
      decision: {
        kind: 'question',
        prompt: qs.map(q => q.question).join(' · '),
        options: (qs[0]?.options || []).map(o => ({
          label: o.label,
          description: o.description,
        })),
        chosen: null,
        decidedBy: 'human',
        interrupted: false,
        questions: qs.map(q => q.question),
      },
    }
  }
  if (name === 'ExitPlanMode') {
    return {
      ...base,
      kind: 'decision',
      label: 'aprobación de plan',
      decision: { kind: 'plan', prompt: 'ExitPlanMode', chosen: null, decidedBy: 'human' },
    }
  }
  // MCP: mcp__server__tool
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return {
    ...base,
    kind: 'tool_call',
    label: mcp ? `mcp:${mcp[1]}/${mcp[2]}` : `tool:${name}`,
  }
}

function fillFromToolResult(step, tur, ctx) {
  if (!tur) return
  // Sub-agente: stats + recursión al transcript del sub-agente
  if (step.kind === 'agent' && tur.agentId) {
    step.agent = step.agent || { steps: [] }
    step.agent.id = tur.agentId
    step.agent.name = tur.agentType || step.agent.name
    step.agent.model = tur.resolvedModel || null
    step.agent.durationMs = tur.totalDurationMs || null
    step.agent.totalTokens = tur.totalTokens || 0
    step.durationMs = tur.totalDurationMs || null
    if (tur.toolStats || tur.totalToolUseCount != null) {
      step.agent.stats = {
        ...(tur.toolStats || {}),
        toolUseCount: tur.totalToolUseCount,
        totalTokens: tur.totalTokens,
      }
    }
    // recursión: parsear el transcript del sub-agente si existe
    const subFile = ctx.subagentMap.get(tur.agentId)
    if (subFile && ctx.depth < 6) {
      const subEntries = readLines(subFile)
      const subMap = buildSubagentMap(
        path.dirname(path.dirname(path.dirname(subFile))),
        path.basename(path.dirname(path.dirname(subFile))),
      )
      // los sub-agentes anidados comparten el mismo dir subagents/; reusar mapa raíz
      const nested = parseTranscript(subEntries, {
        subagentMap: ctx.subagentMap,
        depth: ctx.depth + 1,
        models: ctx.models,
      })
      step.agent.steps = nested
      step.agent.hasNestedSteps = nested.length > 0
      if (!step.agent.name) step.agent.name = metaAgentType(subFile)
    } else {
      step.agent.hasNestedSteps = false
    }
  }
  // Decisión: qué eligió el humano
  if (step.kind === 'decision' && step.decision) {
    if (tur.answers && typeof tur.answers === 'object') {
      step.decision.chosen = Object.values(tur.answers).map(String)
    }
    if (tur.interrupted) step.decision.interrupted = true
  }
}

// ---------------------------------------------------------------------------
// parse(): construye la Traza Canónica de UNA sesión
// ---------------------------------------------------------------------------
async function parse(opts = {}) {
  const file = resolveSessionFile(opts)
  if (!file) throw new Error(`No encontré la sesión: ${opts.session}`)
  const sessionId = path.basename(file, '.jsonl')
  const entries = readLines(file)
  const subagentMap = buildSubagentMap(file, sessionId)
  const models = new Set()

  const steps = parseTranscript(entries, { subagentMap, depth: 0, models })

  const meta = quickMeta(file)
  return {
    schemaVersion: 1,
    source: 'claude-code',
    sessionId,
    title: meta.title,
    cwd: meta.cwd,
    startedAt: meta.firstTs ? new Date(meta.firstTs).toISOString() : null,
    endedAt: meta.lastTs ? new Date(meta.lastTs).toISOString() : null,
    models: [...models],
    steps,
  }
}

function looksLikeClaude(file) {
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n').find(l => l.trim())
    if (!first) return false
    const o = JSON.parse(first)
    // transcripts de Claude Code: traen type/uuid/sessionId y NO el `kind` del NDJSON
    return !!(o && (o.sessionId || o.uuid || o.type) && o.kind === undefined)
  } catch {
    return false
  }
}

function detect(opts = {}) {
  if (opts.source === 'claude-code') return true
  const sess = opts.session
  if (sess) {
    // rutas que claramente no son de Claude Code: que las tome otro adaptador
    if (sess.endsWith('.ndjson') || sess.endsWith('.json')) return false
    if (sess.endsWith('.jsonl')) return fs.existsSync(sess) && looksLikeClaude(sess)
    // id pelado: ¿resuelve a una sesión bajo ~/.claude/projects?
    return resolveSessionFile(opts) != null
  }
  // sin sesión (p.ej. --list/--dashboard): aplica si existe el dir de proyectos
  try {
    return fs.existsSync(projectsRoot(opts))
  } catch {
    return false
  }
}

export default { name: 'claude-code', detect, parse, listSessions }
