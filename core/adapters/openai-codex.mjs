/**
 * Adaptador: OpenAI Codex CLI / Assistants  (best-effort)
 *
 * Codex CLI guarda "rollouts" de sesión como JSONL bajo ~/.codex/sessions/.
 * Cada línea suele ser un item de respuesta: mensajes (role user/assistant),
 * function_call (tool), function_call_output (resultado), reasoning.
 *
 * ⚠️ Best-effort: el formato exacto varía por versión de Codex. Este adaptador
 * mapea las formas más comunes y degrada con gracia (lo desconocido → event).
 * Verifica contra tu versión; si algo no encaja, ajusta `itemToStep`.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

function codexDir(opts) {
  return opts.dir || path.join(os.homedir(), '.codex', 'sessions')
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
      /* ignora */
    }
  }
  return out
}

function asText(content) {
  if (content == null) return null
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(c => (typeof c === 'string' ? c : c.text || c.content || c.input_text || c.output_text || ''))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof content === 'object') return content.text || JSON.stringify(content)
  return String(content)
}

function tokensFrom(u) {
  if (!u) return null
  const input = u.input_tokens ?? u.prompt_tokens ?? 0
  const output = u.output_tokens ?? u.completion_tokens ?? 0
  const cacheRead = u.cached_tokens ?? u.cache_read_input_tokens ?? 0
  return { input, output, cacheRead, cacheCreate: 0, total: input + output + cacheRead }
}

function itemToStep(it, idx, pendingCalls) {
  const ts = it.timestamp || it.ts || null
  const type = it.type || it.role || (it.payload && it.payload.type)
  const p = it.payload || it
  const base = { index: idx, timestamp: ts, flags: [] }

  // mensajes
  if (type === 'message' || p.role) {
    const role = p.role || 'assistant'
    return {
      ...base,
      kind: 'message',
      role,
      label: role === 'user' ? 'prompt del usuario' : 'respuesta',
      text: asText(p.content),
      tokens: tokensFrom(p.usage || it.usage),
    }
  }
  // razonamiento
  if (type === 'reasoning') {
    return { ...base, kind: 'thinking', role: 'assistant', label: 'razonamiento', text: asText(p.content || p.summary) }
  }
  // tool / function call
  if (type === 'function_call' || type === 'tool_call' || type === 'local_shell_call') {
    const name = p.name || p.function?.name || 'tool'
    if (p.call_id) pendingCalls.set(p.call_id, idx)
    return {
      ...base,
      kind: 'tool_call',
      role: 'assistant',
      label: `tool:${name}`,
      io: { input: p.arguments ?? p.input ?? p.action ?? null },
      raw: { callId: p.call_id },
    }
  }
  // resultado de tool
  if (type === 'function_call_output' || type === 'tool_result' || type === 'local_shell_call_output') {
    return {
      ...base,
      kind: 'tool_call',
      role: 'tool',
      label: 'resultado de tool',
      io: { output: asText(p.output ?? p.content), isError: !!p.is_error },
      raw: { callId: p.call_id },
    }
  }
  return { ...base, kind: 'event', label: type || 'evento', text: asText(p.content) }
}

async function parse(opts = {}) {
  const file = resolveFile(opts)
  if (!file) throw new Error(`Codex: no encontré la sesión: ${opts.session}`)
  const items = readLines(file)
  const meta = items.find(i => i.type === 'session_meta' || i.record_type === 'meta') || {}
  const pendingCalls = new Map()
  const steps = items
    .filter(i => (i.type || i.role || i.payload))
    .map((it, idx) => itemToStep(it, idx, pendingCalls))
  const models = new Set()
  for (const it of items) {
    const m = it.model || it.payload?.model || meta.model
    if (m) models.add(m)
  }
  const ts = steps.map(s => s.timestamp).filter(Boolean).sort()
  return {
    schemaVersion: 1,
    source: 'openai-codex',
    sessionId: meta.id || path.basename(file).replace(/\.jsonl$/, ''),
    title: meta.instructions ? String(meta.instructions).slice(0, 80) : null,
    cwd: meta.cwd || null,
    startedAt: ts[0] || null,
    endedAt: ts[ts.length - 1] || null,
    models: [...models],
    steps,
  }
}

function resolveFile(opts) {
  const s = opts.session
  if (s && s.endsWith('.jsonl') && fs.existsSync(s)) return s
  const dir = codexDir(opts)
  if (!fs.existsSync(dir)) return null
  const files = walk(dir).filter(f => f.endsWith('.jsonl'))
  if (s) {
    const hit = files.find(f => path.basename(f, '.jsonl') === s)
    if (hit) return hit
  }
  return files.sort((a, b) => statM(b) - statM(a))[0] || null
}

function walk(dir) {
  const out = []
  let ents
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

function statM(f) {
  try {
    return fs.statSync(f).mtimeMs
  } catch {
    return 0
  }
}

function detect(opts = {}) {
  if (opts.source === 'openai-codex' || opts.source === 'codex') return true
  const s = opts.session
  if (s && s.endsWith('.jsonl') && fs.existsSync(s)) {
    // huele a codex si trae items con function_call / response item types
    try {
      const lines = readLines(s).slice(0, 20)
      return lines.some(l => ['function_call', 'function_call_output', 'reasoning', 'session_meta'].includes(l.type))
    } catch {
      return false
    }
  }
  return fs.existsSync(codexDir(opts))
}

async function listSessions(opts = {}) {
  const dir = codexDir(opts)
  if (!fs.existsSync(dir)) return []
  return walk(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      sessionId: path.basename(f, '.jsonl'),
      source: 'openai-codex',
      file: f,
      title: null,
      startedAt: null,
      endedAt: new Date(statM(f)).toISOString(),
      tokens: 0,
    }))
    .sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''))
}

export default { name: 'openai-codex', detect, parse, listSessions }
