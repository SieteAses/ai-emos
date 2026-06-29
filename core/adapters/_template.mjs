/**
 * Plantilla para un nuevo adaptador.
 *
 * Copia este archivo a core/adapters/<fuente>.mjs, impleméntalo y regístralo en
 * core/adapters/index.mjs. El visor y el render NO cambian: solo consumen la
 * Traza Canónica (ver core/trace-schema.md).
 *
 * Contrato:
 *   export default {
 *     name: string,
 *     detect(opts): boolean,            // ¿esta fuente puede manejar `opts`?
 *     async parse(opts): Trace,         // formato nativo -> Traza Canónica
 *     async listSessions(opts): Row[],  // opcional, para --list / dashboard
 *   }
 *
 * Reglas (ver core/trace-schema.md → "Reglas para autores de adaptadores"):
 *   - No inventes campos fuera del esquema; lo raro va en step.raw / agent.stats.
 *   - Orden cronológico de steps.
 *   - Tokens honestos al nivel que la fuente realmente atribuye; null si no hay.
 *   - Degrada con gracia: lo desconocido va null.
 *   - NO calcules flags ni summary (eso es de core/render.mjs).
 */

function detect(opts = {}) {
  // p.ej. return opts.source === 'mi-fuente' || (opts.file && opts.file.endsWith('.miext'))
  return false
}

async function parse(opts = {}) {
  // 1. leer el formato nativo desde opts.session / opts.file
  // 2. construir steps[] (kind: message|thinking|llm_call|tool_call|agent|skill|decision|event)
  // 3. devolver la Traza Canónica:
  return {
    schemaVersion: 1,
    source: 'mi-fuente',
    sessionId: opts.session || 'unknown',
    title: null,
    cwd: null,
    startedAt: null,
    endedAt: null,
    models: [],
    steps: [],
  }
}

async function listSessions() {
  return []
}

export default { name: 'mi-fuente', detect, parse, listSessions }
