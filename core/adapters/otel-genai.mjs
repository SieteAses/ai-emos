/**
 * Adaptador universal: OpenTelemetry GenAI / OpenInference  (vía estándar)
 *
 * Ingiere un archivo OTLP-JSON (export de spans) y lo convierte a Traza Canónica.
 * Cubre CUALQUIER sistema de IA instrumentado con OTel-GenAI u OpenInference
 * (LangChain, LlamaIndex, frameworks propios, etc.) con un solo adaptador.
 *
 * Maneja ambas convenciones de atributos:
 *   OTel-GenAI:   gen_ai.operation.name, gen_ai.request.model,
 *                 gen_ai.usage.input_tokens / output_tokens, gen_ai.tool.name
 *   OpenInference: openinference.span.kind (LLM|TOOL|AGENT|CHAIN|RETRIEVER),
 *                 llm.token_count.prompt / completion, llm.model_name, tool.name
 *
 * Una sesión = un traceId. Si el archivo trae varios traces, elige el que
 * coincide con --session, o el primero.
 */

import fs from 'fs'

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// OTLP attributes: [{key, value:{stringValue|intValue|doubleValue|boolValue}}]
function attrVal(v) {
  if (v == null) return null
  if (v.stringValue != null) return v.stringValue
  if (v.intValue != null) return Number(v.intValue)
  if (v.doubleValue != null) return v.doubleValue
  if (v.boolValue != null) return v.boolValue
  if (v.value != null) return attrVal(v.value)
  return null
}

function attrsToMap(attributes) {
  const m = {}
  for (const a of attributes || []) m[a.key] = attrVal(a.value)
  return m
}

// extrae todos los spans del OTLP-JSON, normalizados
function extractSpans(doc) {
  const spans = []
  for (const rs of doc.resourceSpans || doc.resource_spans || []) {
    for (const ss of rs.scopeSpans || rs.scope_spans || rs.instrumentationLibrarySpans || []) {
      for (const sp of ss.spans || []) {
        const a = attrsToMap(sp.attributes)
        spans.push({
          traceId: sp.traceId || sp.trace_id,
          spanId: sp.spanId || sp.span_id,
          parentSpanId: sp.parentSpanId || sp.parent_span_id || null,
          name: sp.name || '',
          startNano: Number(sp.startTimeUnixNano || sp.start_time_unix_nano || 0),
          endNano: Number(sp.endTimeUnixNano || sp.end_time_unix_nano || 0),
          status: sp.status,
          a,
        })
      }
    }
  }
  return spans
}

function nanoToIso(n) {
  if (!n) return null
  return new Date(Math.floor(n / 1e6)).toISOString()
}

function spanKind(a, name) {
  const oi = (a['openinference.span.kind'] || a['span.kind'] || '').toString().toUpperCase()
  if (oi) return oi
  const op = (a['gen_ai.operation.name'] || '').toString().toLowerCase()
  if (op.includes('chat') || op.includes('completion') || op.includes('generate')) return 'LLM'
  if (op.includes('tool') || op.includes('execute_tool')) return 'TOOL'
  if (op.includes('agent') || op.includes('invoke_agent')) return 'AGENT'
  if (a['gen_ai.tool.name'] || a['tool.name']) return 'TOOL'
  if (a['gen_ai.request.model'] || a['llm.model_name']) return 'LLM'
  return 'CHAIN'
}

function spanTokens(a) {
  const input =
    a['gen_ai.usage.input_tokens'] ?? a['llm.token_count.prompt'] ?? a['gen_ai.usage.prompt_tokens']
  const output =
    a['gen_ai.usage.output_tokens'] ??
    a['llm.token_count.completion'] ??
    a['gen_ai.usage.completion_tokens']
  if (input == null && output == null) return null
  const i = Number(input || 0)
  const o = Number(output || 0)
  return { input: i, output: o, cacheRead: 0, cacheCreate: 0, total: i + o }
}

function spanIO(a) {
  const input =
    a['gen_ai.prompt'] ?? a['input.value'] ?? a['llm.input_messages'] ?? a['gen_ai.tool.input']
  const output =
    a['gen_ai.completion'] ??
    a['output.value'] ??
    a['llm.output_messages'] ??
    a['gen_ai.tool.output']
  const isError =
    a['error'] === true || (a['otel.status_code'] || '').toString().toUpperCase() === 'ERROR'
  if (input == null && output == null && !isError) return null
  return { input: input ?? null, output: output ?? null, isError }
}

function kindToCanonical(k) {
  switch (k) {
    case 'LLM':
      return 'llm_call'
    case 'TOOL':
      return 'tool_call'
    case 'AGENT':
      return 'agent'
    case 'RETRIEVER':
      return 'tool_call'
    default:
      return 'event' // CHAIN u otros
  }
}

function spanToStep(sp, idx) {
  const a = sp.a
  const k = spanKind(a, sp.name)
  const kind = kindToCanonical(k)
  const model = a['gen_ai.request.model'] || a['llm.model_name'] || null
  const toolName = a['gen_ai.tool.name'] || a['tool.name'] || sp.name
  const durationMs =
    sp.endNano && sp.startNano ? Math.round((sp.endNano - sp.startNano) / 1e6) : null
  const step = {
    index: idx,
    timestamp: nanoToIso(sp.startNano),
    kind,
    label:
      kind === 'tool_call'
        ? `tool:${toolName}`
        : kind === 'agent'
          ? `agente:${a['gen_ai.agent.name'] || sp.name}`
          : kind === 'llm_call'
            ? `llm:${model || sp.name}`
            : sp.name,
    role: kind === 'llm_call' ? 'assistant' : null,
    text: null,
    io: spanIO(a),
    tokens: spanTokens(a),
    durationMs,
    flags: [],
    raw: { spanId: sp.spanId, model },
  }
  if (kind === 'agent') {
    const tk = spanTokens(a)
    step.agent = {
      name: a['gen_ai.agent.name'] || sp.name,
      id: sp.spanId,
      model,
      durationMs,
      totalTokens: tk ? tk.total : 0,
      hasNestedSteps: false,
      steps: [],
      stats: null,
    }
  }
  return { step, model }
}

async function parse(opts = {}) {
  const file = opts.session?.endsWith?.('.json') ? opts.session : opts.file
  const target = file || opts.session
  if (!target || !fs.existsSync(target)) throw new Error(`OTel: no encontré el archivo: ${target}`)
  const doc = readJson(target)
  if (!doc) throw new Error(`OTel: JSON inválido en ${target}`)
  let spans = extractSpans(doc)
  if (!spans.length) throw new Error('OTel: no encontré spans')

  // elegir un trace
  const traceId =
    opts.traceId ||
    (opts.session && spans.some(s => s.traceId === opts.session) ? opts.session : spans[0].traceId)
  spans = spans.filter(s => s.traceId === traceId).sort((a, b) => a.startNano - b.startNano)

  const models = new Set()
  const byId = new Map()
  const idx = { v: 0 }
  for (const sp of spans) {
    const { step, model } = spanToStep(sp, idx.v++)
    if (model) models.add(model)
    byId.set(sp.spanId, { sp, step })
  }

  // anidar bajo el agente padre más cercano
  const top = []
  for (const { sp, step } of byId.values()) {
    let parent = sp.parentSpanId ? byId.get(sp.parentSpanId) : null
    // sube hasta encontrar un padre de tipo agent
    while (parent && parent.step.kind !== 'agent') {
      parent = parent.sp.parentSpanId ? byId.get(parent.sp.parentSpanId) : null
    }
    if (parent && parent.step.kind === 'agent' && parent.step !== step) {
      parent.step.agent.steps.push(step)
      parent.step.agent.hasNestedSteps = true
    } else {
      top.push(step)
    }
  }

  const ts = spans
    .map(s => nanoToIso(s.startNano))
    .filter(Boolean)
    .sort()
  const endTs = spans
    .map(s => nanoToIso(s.endNano))
    .filter(Boolean)
    .sort()
  return {
    schemaVersion: 1,
    source: 'otel-genai',
    sessionId: traceId,
    title: null,
    cwd: null,
    startedAt: ts[0] || null,
    endedAt: endTs[endTs.length - 1] || null,
    models: [...models],
    steps: top,
  }
}

function detect(opts = {}) {
  if (opts.source === 'otel' || opts.source === 'otel-genai') return true
  const f = opts.file || (opts.session?.endsWith?.('.json') ? opts.session : null)
  if (!f || !fs.existsSync(f)) return false
  try {
    const doc = readJson(f)
    return !!(doc && (doc.resourceSpans || doc.resource_spans))
  } catch {
    return false
  }
}

async function listSessions(opts = {}) {
  const f = opts.file || (opts.session?.endsWith?.('.json') ? opts.session : null)
  if (!f || !fs.existsSync(f)) return []
  const doc = readJson(f)
  if (!doc) return []
  const spans = extractSpans(doc)
  const traces = new Map()
  for (const s of spans) {
    if (!traces.has(s.traceId)) traces.set(s.traceId, { first: s.startNano, last: s.endNano })
    const t = traces.get(s.traceId)
    t.first = Math.min(t.first, s.startNano)
    t.last = Math.max(t.last, s.endNano)
  }
  return [...traces.entries()].map(([traceId, t]) => ({
    sessionId: traceId,
    source: 'otel-genai',
    file: f,
    title: null,
    startedAt: nanoToIso(t.first),
    endedAt: nanoToIso(t.last),
    tokens: 0,
  }))
}

export default { name: 'otel-genai', detect, parse, listSessions }
