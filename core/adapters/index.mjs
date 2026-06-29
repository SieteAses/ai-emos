/**
 * core/adapters/index.mjs — registry de adaptadores.
 *
 * Cada adaptador implementa { name, detect(opts), parse(opts), listSessions(opts) }
 * y convierte su formato nativo a la Traza Canónica (core/trace-schema.md).
 * Agregar una fuente = agregar un import aquí; el visor y el render no cambian.
 *
 * Orden = prioridad de auto-detección (el primero cuyo detect() dé true gana).
 */

import claudeCode from './claude-code.mjs'
import ndjson from './ndjson-events.mjs'
import otel from './otel-genai.mjs'
import cursor from './cursor.mjs'
import openaiCodex from './openai-codex.mjs'
import opencode from './opencode.mjs'

export const ADAPTERS = [claudeCode, ndjson, otel, cursor, openaiCodex, opencode]

export function byName(name) {
  return ADAPTERS.find(a => a.name === name) || null
}

// Elige adaptador: explícito por opts.source/--adapter, o auto vía detect().
export function pick(opts = {}) {
  const wanted = opts.adapter || opts.source
  if (wanted) {
    const a = byName(wanted)
    if (a) return a
    // alias sueltos
    const alias = { 'claude': 'claude-code', 'cc': 'claude-code', 'codex': 'openai-codex', 'otel-genai': 'otel-genai' }
    if (alias[wanted]) return byName(alias[wanted])
  }
  for (const a of ADAPTERS) {
    try {
      if (a.detect(opts)) return a
    } catch {
      /* detect tolerante */
    }
  }
  return null
}

export async function parse(opts = {}) {
  const a = pick(opts)
  if (!a) throw new Error('No encontré un adaptador para esta fuente. Usa --adapter <claude-code|ndjson|otel-genai|cursor|openai-codex>.')
  const trace = await a.parse(opts)
  trace.source = trace.source || a.name
  return trace
}

export async function listSessions(opts = {}) {
  const a = pick(opts)
  if (a && a.listSessions) return a.listSessions(opts)
  return []
}

export default { ADAPTERS, byName, pick, parse, listSessions }
