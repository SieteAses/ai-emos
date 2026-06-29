/**
 * Adaptador universal: eventos NDJSON  (vía para agentes caseros)
 *
 * Cualquier sistema de IA puede emitir un archivo .ndjson (una línea = un evento
 * JSON) usando el mini-SDK en sdk/ (o a mano) y este adaptador lo convierte a
 * Traza Canónica. Es el camino más simple para hacer observable un agente propio
 * sin instrumentación OTel.
 *
 * Spec de evento (todos los campos opcionales salvo `kind`):
 *   { "ts": ISO, "kind": "message|thinking|llm_call|tool_call|agent|skill|decision|event",
 *     "label": str, "role": "user|assistant|system|tool",
 *     "text": str, "input": any, "output": any, "isError": bool,
 *     "tokens": {input,output,cacheRead,cacheCreate,total},
 *     "durationMs": int,
 *     "agentName": str, "agentId": str, "parentId": str,   // anidación de sub-agentes
 *     "decision": {prompt, options, chosen, decidedBy, interrupted} }
 *
 * Una cabecera opcional (primera línea con kind:"session") aporta metadata:
 *   { "kind":"session", "sessionId":..., "title":..., "source":..., "models":[...] }
 */

import fs from 'fs'
import path from 'path'

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
      /* ignora líneas corruptas */
    }
  }
  return out
}

function tok(t) {
  if (!t) return null
  const input = t.input || 0
  const output = t.output || 0
  const cacheRead = t.cacheRead || 0
  const cacheCreate = t.cacheCreate || 0
  return {
    input,
    output,
    cacheRead,
    cacheCreate,
    total: t.total != null ? t.total : input + output + cacheRead + cacheCreate,
  }
}

function eventToStep(e, idx) {
  const step = {
    index: idx,
    timestamp: e.ts || null,
    kind: e.kind,
    label: e.label || e.kind,
    role: e.role || null,
    text: e.text || null,
    io:
      e.input != null || e.output != null || e.isError != null
        ? { input: e.input ?? null, output: e.output ?? null, isError: !!e.isError }
        : null,
    tokens: tok(e.tokens),
    durationMs: e.durationMs || null,
    flags: [],
  }
  if (e.kind === 'agent') {
    step.agent = {
      name: e.agentName || e.label || null,
      id: e.agentId || null,
      durationMs: e.durationMs || null,
      totalTokens: e.tokens?.total || 0,
      hasNestedSteps: false,
      steps: [],
      stats: e.stats || null,
    }
  }
  if (e.kind === 'decision') {
    step.decision = e.decision || { prompt: e.text || '', chosen: null }
  }
  return step
}

// Anida eventos hijos (parentId) bajo su paso agent; el resto queda al tope.
function buildSteps(events) {
  const top = []
  const stepById = new Map() // agentId -> step agent
  let idx = 0
  for (const e of events) {
    if (e.kind === 'session') continue
    const step = eventToStep(e, idx++)
    if (e.kind === 'agent' && step.agent.id) stepById.set(step.agent.id, step)
    if (e.parentId && stepById.has(e.parentId)) {
      const parent = stepById.get(e.parentId)
      parent.agent.steps.push(step)
      parent.agent.hasNestedSteps = true
    } else {
      top.push(step)
    }
  }
  return top
}

async function parse(opts = {}) {
  const file = resolveFile(opts)
  if (!file) throw new Error(`NDJSON: no encontré el archivo: ${opts.session || opts.file}`)
  const events = readLines(file)
  const header = events.find(e => e.kind === 'session') || {}
  const steps = buildSteps(events)
  const ts = events.map(e => e.ts).filter(Boolean).sort()
  const models = new Set(header.models || [])
  for (const e of events) if (e.model) models.add(e.model)
  return {
    schemaVersion: 1,
    source: header.source || 'ndjson',
    sessionId: header.sessionId || path.basename(file).replace(/\.(ndjson|jsonl)$/, ''),
    title: header.title || null,
    cwd: header.cwd || null,
    startedAt: ts[0] || null,
    endedAt: ts[ts.length - 1] || null,
    models: [...models],
    steps,
  }
}

function resolveFile(opts) {
  const f = opts.session || opts.file
  if (f && fs.existsSync(f)) return f
  return null
}

function detect(opts = {}) {
  if (opts.source === 'ndjson') return true
  const f = opts.session || opts.file
  if (!f || !fs.existsSync(f)) return false
  if (f.endsWith('.ndjson')) return true
  // .jsonl: huele si la primera línea no-vacía trae nuestra forma (kind sin uuid)
  try {
    const first = fs.readFileSync(f, 'utf8').split('\n').find(l => l.trim())
    if (!first) return false
    const o = JSON.parse(first)
    return o && typeof o.kind === 'string' && o.uuid === undefined && o.type === undefined
  } catch {
    return false
  }
}

async function listSessions() {
  return [] // NDJSON se pasa por ruta de archivo explícita
}

export default { name: 'ndjson', detect, parse, listSessions }
