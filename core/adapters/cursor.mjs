/**
 * Adaptador: Cursor  (best-effort)
 *
 * Cursor guarda el historial de chat en SQLite (state.vscdb), que no se puede
 * leer sin dependencias nativas. Por eso este adaptador trabaja sobre un
 * **export JSON** del chat:
 *
 *   - Exporta el chat de Cursor a JSON, o
 *   - vuelca la clave de chat de state.vscdb a un .json
 *
 * Acepta varias formas de export comunes y degrada con gracia:
 *   { "messages": [ { "role": "user|assistant", "text"|"content": ... } ] }
 *   [ { role, content }, ... ]
 *   { "conversation": { "messages": [...] } }
 *   { "bubbles": [ { "type": "user|ai", "text": ... } ] }   // forma interna
 *
 * ⚠️ Best-effort: ajusta `pickMessages` / `bubbleToStep` a tu export si difiere.
 */

import fs from 'fs'
import path from 'path'

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function pickMessages(doc) {
  if (Array.isArray(doc)) return doc
  if (Array.isArray(doc?.messages)) return doc.messages
  if (Array.isArray(doc?.conversation?.messages)) return doc.conversation.messages
  if (Array.isArray(doc?.bubbles)) return doc.bubbles
  if (Array.isArray(doc?.chat?.messages)) return doc.chat.messages
  return []
}

function asText(c) {
  if (c == null) return null
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(asText).filter(Boolean).join('\n')
  if (typeof c === 'object') return c.text || c.content || c.value || JSON.stringify(c)
  return String(c)
}

function roleOf(m) {
  const r = m.role || m.type || m.author
  if (!r) return 'assistant'
  const s = String(r).toLowerCase()
  if (s.includes('user') || s === 'human') return 'user'
  if (s.includes('assist') || s === 'ai' || s === 'bot') return 'assistant'
  if (s.includes('tool')) return 'tool'
  return 'assistant'
}

function bubbleToStep(m, idx) {
  const role = roleOf(m)
  const ts = m.timestamp || m.createdAt || m.ts || null
  const base = { index: idx, timestamp: ts, flags: [] }

  // tool / command calls que algunos exports incluyen
  const calls = m.toolCalls || m.tool_calls || m.commands || null
  if (calls && calls.length) {
    // representamos el primer call como tool_call; el texto va aparte si existe
    const c = calls[0]
    return {
      ...base,
      kind: 'tool_call',
      role: 'assistant',
      label: `tool:${c.name || c.tool || 'tool'}`,
      io: { input: c.args ?? c.input ?? null, output: c.result ?? c.output ?? null, isError: !!c.isError },
      text: asText(m.text || m.content) || null,
    }
  }

  return {
    ...base,
    kind: role === 'tool' ? 'tool_call' : 'message',
    role,
    label: role === 'user' ? 'prompt del usuario' : role === 'tool' ? 'resultado de tool' : 'respuesta',
    text: asText(m.text ?? m.content ?? m.richText),
  }
}

async function parse(opts = {}) {
  const file = opts.session || opts.file
  if (!file || !fs.existsSync(file)) {
    throw new Error(
      `Cursor: pasa la ruta a un export JSON del chat (--session export.json). ` +
        `Cursor guarda el chat en SQLite; expórtalo a JSON primero.`,
    )
  }
  const doc = readJson(file)
  if (!doc) throw new Error(`Cursor: JSON inválido en ${file}`)
  const msgs = pickMessages(doc)
  const steps = msgs.map(bubbleToStep).filter(s => s.text || s.io)
  // reindexar tras el filtro
  steps.forEach((s, i) => (s.index = i))
  const ts = steps.map(s => s.timestamp).filter(Boolean).sort()
  return {
    schemaVersion: 1,
    source: 'cursor',
    sessionId: doc.id || doc.composerId || path.basename(file).replace(/\.json$/, ''),
    title: doc.title || doc.name || null,
    cwd: doc.workspace || null,
    startedAt: ts[0] || null,
    endedAt: ts[ts.length - 1] || null,
    models: doc.model ? [doc.model] : [],
    steps,
  }
}

function detect(opts = {}) {
  if (opts.source === 'cursor') return true
  const f = opts.session || opts.file
  if (!f || !fs.existsSync(f) || !f.endsWith('.json')) return false
  const doc = readJson(f)
  return !!(doc && pickMessages(doc).length)
}

async function listSessions() {
  return [] // export JSON explícito por ruta
}

export default { name: 'cursor', detect, parse, listSessions }
