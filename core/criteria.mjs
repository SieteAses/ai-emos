/**
 * core/criteria.mjs — criterios de "óptimo vs no-óptimo", explícitos y configurables.
 *
 * Responde, en un solo lugar y de forma reproducible, la pregunta:
 *   ¿qué cuenta como "demasiados tokens", "muy lento" o "error"?
 *
 * El evaluador mecánico (core/render.mjs) consume estos umbrales. El diseño es
 * HÍBRIDO: una flag dispara si se cumple CUALQUIERA de tres condiciones —
 *
 *   1. ABSOLUTO  — supera un presupuesto fijo (reproducible entre sesiones).
 *   2. BASELINE  — se desvía > `sigma`·σ de la media histórica de ESE agente
 *                  /herramienta (cuando hay ≥ `minSamples` muestras).
 *   3. P90       — está en el percentil 90 DENTRO de la sesión actual
 *                  (relativo; el comportamiento original de render.mjs).
 *
 * `error` y `retry` no tienen umbral: son binarios (isError / repetición).
 *
 * Todos los números son configurables; ver `loadCriteria`. Documentación
 * legible en core/criteria.md.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

// Defaults conservadores: pensados para no marcar lo normal y resaltar lo atípico.
export const DEFAULTS = {
  tokens: {
    turnBudget: 80_000, // tokens de un turno del LLM por encima de esto = caro
    agentBudget: 150_000, // tokens totales de un sub-agente por encima de esto = caro
  },
  durationMs: {
    tool: 30_000, // una herramienta que tarda > 30 s = lenta
    agent: 300_000, // un sub-agente que tarda > 5 min = lento
  },
  coldCache: {
    minInput: 50_000, // input grande (umbral original COLD_CACHE_MIN_INPUT)
    minCacheRatio: 0.5, // si cacheRead < input * ratio ⇒ poca caché (recontextualización)
  },
  baseline: {
    sigma: 2, // nº de desviaciones estándar sobre la media del agente para marcar
    minSamples: 5, // mínimo de muestras históricas para confiar en el baseline
  },
  // p90 intra-sesión: heredado de render.mjs. `enabled:false` lo desactiva.
  p90: { enabled: true, minSamples: 3 },
}

// Mezcla profunda (1 nivel de objetos) de overrides sobre los defaults.
function merge(base, over) {
  if (!over || typeof over !== 'object') return base
  const out = { ...base }
  for (const k of Object.keys(over)) {
    const v = over[k]
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v
  }
  return out
}

function readJsonSafe(file) {
  try {
    if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    /* archivo de criterios ilegible: se ignora, gana el default */
  }
  return null
}

// Ruta del archivo de criterios del usuario (~/.config/ai-emos/criteria.json).
export function userCriteriaPath() {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(cfg, 'ai-emos', 'criteria.json')
}

/**
 * Construye los criterios efectivos mezclando, por orden de prioridad creciente:
 *   DEFAULTS ← ~/.config/ai-emos/criteria.json ← .ai-emos.json del cwd ← `overrides`.
 * `overrides` permite inyectar settings de VS Code o un --criteria del CLI.
 */
export function loadCriteria(overrides = {}, { cwd = process.cwd() } = {}) {
  let c = DEFAULTS
  c = merge(c, readJsonSafe(userCriteriaPath()))
  c = merge(c, readJsonSafe(path.join(cwd, '.ai-emos.json'))?.criteria || null)
  c = merge(c, overrides)
  return c
}

// Ruta del baseline persistido (~/.config/ai-emos/baselines.json).
export function baselinesPath() {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(cfg, 'ai-emos', 'baselines.json')
}

export function loadBaselines() {
  return readJsonSafe(baselinesPath())
}

// Persiste el mapa de baselines (lo produce render.aggregate). Best-effort:
// crea el directorio si falta y nunca lanza (la observabilidad no debe romper).
export function saveBaselines(baselines) {
  try {
    const file = baselinesPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(baselines, null, 2))
    return file
  } catch {
    return null
  }
}

export default { DEFAULTS, loadCriteria, userCriteriaPath, baselinesPath, loadBaselines, saveBaselines }
