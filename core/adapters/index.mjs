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
import vscodeChat from './vscode-chat.mjs'

export const ADAPTERS = [claudeCode, ndjson, otel, cursor, openaiCodex, opencode, vscodeChat]

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
    const alias = {
      claude: 'claude-code',
      cc: 'claude-code',
      codex: 'openai-codex',
      'otel-genai': 'otel-genai',
      copilot: 'vscode-chat',
      vscode: 'vscode-chat',
      'vs-code': 'vscode-chat',
    }
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
  if (!a)
    throw new Error(
      'No encontré un adaptador para esta fuente. Usa --adapter <claude-code|ndjson|otel-genai|cursor|openai-codex|opencode|vscode-chat>.',
    )
  const trace = await a.parse(opts)
  trace.source = trace.source || a.name
  return trace
}

export async function listSessions(opts = {}) {
  // adaptador explícito (--adapter/--source): lista solo esa fuente.
  if (opts.adapter || opts.source) {
    const a = pick(opts)
    if (a && a.listSessions) {
      const rows = await a.listSessions(opts)
      return rows.map(r => (r.source ? r : { ...r, source: a.name }))
    }
    return []
  }
  // sin adaptador: AGREGA todas las fuentes que sepan listar, etiquetando cada
  // fila con su `source`, para una lista unificada (Claude Code, Copilot, …).
  const all = []
  for (const a of ADAPTERS) {
    if (!a.listSessions) continue
    try {
      const rows = await a.listSessions(opts)
      for (const r of rows) all.push(r.source ? r : { ...r, source: a.name })
    } catch {
      /* fuente no disponible/listable: se omite */
    }
  }
  all.sort((x, y) => (y.endedAt || '').localeCompare(x.endedAt || ''))
  return all
}

export default { ADAPTERS, byName, pick, parse, listSessions }
