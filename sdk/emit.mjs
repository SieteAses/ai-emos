/**
 * sdk/emit.mjs — mini-SDK para que CUALQUIER agente JS/TS emita una traza
 * observable por ai-emos, sin OTel y sin dependencias.
 *
 * Escribe un archivo NDJSON que el adaptador `ndjson` ingiere tal cual.
 *
 *   import { Tracer } from 'ai-emos/sdk/emit.mjs'
 *   const t = new Tracer('./traces/run.ndjson', { title: 'mi corrida', source: 'mi-agente' })
 *   t.message('user', '¿qué hago?')
 *   const a = t.agent('investigador', { id: 'a1' })
 *   a.tool('search', { input: 'leaflet', output: '...', tokens: { input: 10, output: 5 } })
 *   t.decision('¿seguir?', { options: ['sí','no'], chosen: ['sí'] })
 *   t.close()
 *
 * Diseñado para ser copiado/portado: la "API" es solo escribir líneas JSON.
 */

import fs from 'fs'
import path from 'path'

export class Tracer {
  constructor(file, meta = {}) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.fd = fs.openSync(file, 'w')
    this._write({
      kind: 'session',
      sessionId: meta.sessionId || path.basename(file).replace(/\.ndjson$/, ''),
      title: meta.title || null,
      source: meta.source || 'ndjson',
      cwd: meta.cwd || process.cwd(),
      models: meta.models || [],
    })
  }

  _write(obj) {
    if (!obj.ts && obj.kind !== 'session') obj.ts = new Date().toISOString()
    fs.writeSync(this.fd, JSON.stringify(obj) + '\n')
  }

  // pasos de nivel superior
  message(role, text, extra = {}) {
    this._write({ kind: 'message', role, text, ...extra })
    return this
  }
  thinking(text, extra = {}) {
    this._write({ kind: 'thinking', role: 'assistant', text, ...extra })
    return this
  }
  llm(label, { tokens, input, output, durationMs, model } = {}) {
    this._write({ kind: 'llm_call', label, tokens, input, output, durationMs, model })
    return this
  }
  tool(name, { input, output, isError, tokens, durationMs, parentId } = {}) {
    this._write({ kind: 'tool_call', label: `tool:${name}`, input, output, isError, tokens, durationMs, parentId })
    return this
  }
  skill(name, extra = {}) {
    this._write({ kind: 'skill', label: `skill:${name}`, ...extra })
    return this
  }
  decision(prompt, { options, chosen, decidedBy = 'human', interrupted = false } = {}) {
    this._write({ kind: 'decision', label: 'decisión humana', decision: { prompt, options, chosen, decidedBy, interrupted } })
    return this
  }
  event(label, extra = {}) {
    this._write({ kind: 'event', label, ...extra })
    return this
  }

  // sub-agente: devuelve un proxy que etiqueta sus pasos con parentId
  agent(name, { id, tokens, durationMs, stats } = {}) {
    const agentId = id || `a${Math.floor(performance.now())}_${name}`
    this._write({ kind: 'agent', label: `agente:${name}`, agentName: name, agentId, tokens, durationMs, stats })
    const self = this
    const child = pid => ({
      message: (role, text, e = {}) => (self._write({ kind: 'message', role, text, parentId: pid, ...e }), child(pid)),
      thinking: (text, e = {}) => (self._write({ kind: 'thinking', role: 'assistant', text, parentId: pid, ...e }), child(pid)),
      tool: (n, o = {}) => (self.tool(n, { ...o, parentId: pid }), child(pid)),
      llm: (label, o = {}) => (self._write({ kind: 'llm_call', label, parentId: pid, ...o }), child(pid)),
    })
    return child(agentId)
  }

  close() {
    try {
      fs.closeSync(this.fd)
    } catch {
      /* noop */
    }
  }
}

export default { Tracer }
