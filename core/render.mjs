/**
 * core/render.mjs — agnóstico a la fuente.
 *
 * Toma una Traza Canónica (de cualquier adaptador) y la enriquece para el visor:
 *  - calcula `flags` mecánicas por paso
 *  - los traduce a `findings` ("tramos a revisar") con category + severity
 *  - calcula tokens agregados de la sesión (sin doble-conteo de sub-agentes)
 *  - construye `summary`
 *
 * Paraguas conceptual: "tramos a revisar". Cada hallazgo lleva:
 *   category: 'eficiencia' | 'friccion' | 'latencia' | 'calidad'
 *   severity: 'alta' | 'media' | 'baja'
 * Las tres primeras categorías se detectan mecánicamente aquí (cero LLM, cero
 * tokens). 'calidad' la aporta el paso opcional de LLM-judge (core/judge.mjs),
 * que es backend-agnóstico (modelo del chat / local / API).
 *
 * Esto vive en el núcleo, NO en los adaptadores, para que toda fuente reciba el
 * mismo análisis.
 */

import { loadCriteria } from './criteria.mjs'

// flag mecánica -> {category, severity, why}
const FLAG_META = {
  error: { category: 'friccion', severity: 'alta', why: 'la herramienta devolvió error' },
  retry: { category: 'friccion', severity: 'media', why: 'reintento del mismo paso tras un error' },
  interrupted: { category: 'friccion', severity: 'media', why: 'el usuario interrumpió el turno' },
  slow: { category: 'latencia', severity: 'media', why: 'sub-agente lento (≥ p90 de duración)' },
  expensive: { category: 'eficiencia', severity: 'media', why: 'sub-agente caro (≥ p90 de tokens)' },
  'cold-cache': { category: 'eficiencia', severity: 'media', why: 'input grande con poca caché (recontextualización)' },
}

function sumTokens(steps) {
  const acc = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 }
  const add = t => {
    if (!t) return
    acc.input += t.input || 0
    acc.output += t.output || 0
    acc.cacheRead += t.cacheRead || 0
    acc.cacheCreate += t.cacheCreate || 0
    acc.total += t.total || 0
  }
  for (const s of steps) {
    add(s.tokens)
    if (s.kind === 'agent' && s.agent) {
      if (s.agent.hasNestedSteps && s.agent.steps?.length) {
        const sub = sumTokens(s.agent.steps)
        acc.input += sub.input
        acc.output += sub.output
        acc.cacheRead += sub.cacheRead
        acc.cacheCreate += sub.cacheCreate
        acc.total += sub.total
      } else if (s.agent.totalTokens) {
        acc.total += s.agent.totalTokens
      }
    }
  }
  return acc
}

function percentile(arr, p) {
  if (!arr.length) return Infinity
  const sorted = [...arr].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i]
}

// Diseño HÍBRIDO: una flag con umbral dispara si se cumple CUALQUIERA de tres
// condiciones. Devuelve la etiqueta del primer disparador que aplica, o null.
// Ver core/criteria.md para la semántica.
function hybridTrigger(value, { absolute, p90, baseline, criteria }) {
  if (!value) return null
  if (absolute != null && value > absolute) return 'absoluto'
  if (
    baseline &&
    baseline.samples >= criteria.baseline.minSamples &&
    isFinite(baseline.std) &&
    value > baseline.mean + criteria.baseline.sigma * baseline.std
  ) {
    return 'baseline'
  }
  if (criteria.p90.enabled && isFinite(p90) && value >= p90) return 'p90'
  return null
}

// Marca flags por paso y acumula findings (con ruta legible).
// ctx = { criteria, baselines, durP90, tokP90 }
function flagSteps(steps, ctx, findings, pathLabel = '') {
  const { criteria, baselines, durP90, tokP90 } = ctx
  const prevByLabel = new Map() // label -> hubo error en la última aparición

  steps.forEach(s => {
    const flags = new Set(s.flags || [])
    const triggers = {} // flag -> 'absoluto' | 'baseline' | 'p90'

    if (s.io && s.io.isError) flags.add('error')

    if ((s.kind === 'tool_call' || s.kind === 'agent') && s.label) {
      if (prevByLabel.get(s.label)) flags.add('retry')
      prevByLabel.set(s.label, !!(s.io && s.io.isError))
    }

    if (s.kind === 'agent' && s.agent) {
      const base = baselines && baselines[s.agent.name]
      const slowT = hybridTrigger(s.durationMs, {
        absolute: criteria.durationMs.agent,
        p90: durP90,
        baseline: base && base.durationMs,
        criteria,
      })
      if (slowT) {
        flags.add('slow')
        triggers.slow = slowT
      }
      const expT = hybridTrigger(s.agent.totalTokens || 0, {
        absolute: criteria.tokens.agentBudget,
        p90: tokP90,
        baseline: base && base.tokens,
        criteria,
      })
      if (expT) {
        flags.add('expensive')
        triggers.expensive = expT
      }
    }

    // Coste por TURNO del LLM (granularidad real de tokens): solo presupuesto
    // absoluto — p90/baseline de turnos no se modela aún. Se mide sobre tokens
    // FRESCOS (input+output), no `total`: el `cacheRead` es barato y, contado,
    // dispararía en casi cada turno. La caché grande la cubre `cold-cache`.
    if (s.kind !== 'agent' && s.tokens) {
      const fresh = (s.tokens.input || 0) + (s.tokens.output || 0)
      if (fresh > criteria.tokens.turnBudget) {
        flags.add('expensive')
        triggers.expensive = triggers.expensive || 'absoluto'
      }
    }

    if (s.tokens) {
      const { input = 0, cacheRead = 0 } = s.tokens
      if (input > criteria.coldCache.minInput && cacheRead < input * criteria.coldCache.minCacheRatio) {
        flags.add('cold-cache')
        triggers['cold-cache'] = 'absoluto'
      }
    }

    if (s.decision && s.decision.interrupted) flags.add('interrupted')

    s.flags = [...flags]

    if (s.flags.length) {
      const metas = s.flags.map(f => FLAG_META[f]).filter(Boolean)
      if (metas.length) {
        const sevRank = { alta: 3, media: 2, baja: 1 }
        const top = metas.reduce((a, b) => (sevRank[b.severity] > sevRank[a.severity] ? b : a))
        const trigList = [...new Set(Object.values(triggers))]
        findings.push({
          index: s.index,
          path: pathLabel,
          kind: s.kind,
          label: s.label,
          flags: s.flags,
          triggers, // por flag: qué condición la disparó
          trigger: trigList.length ? trigList.join('+') : null,
          category: top.category,
          severity: top.severity,
          why: metas.map(m => m.why).join('; '),
          source: 'mecanico',
        })
      }
    }

    if (s.kind === 'agent' && s.agent && s.agent.steps?.length) {
      flagSteps(s.agent.steps, ctx, findings, `${pathLabel}${s.label} › `)
    }
  })
}

// stats nativas tipo `<tool>Count` → frecuencia de herramientas por nombre.
// Excluye `toolUseCount` (es el total) y stats que no son conteos de tool.
const STAT_TO_TOOL = {
  readCount: 'Read', bashCount: 'Bash', editFileCount: 'Edit', writeCount: 'Write',
  grepCount: 'Grep', globCount: 'Glob', webFetchCount: 'WebFetch', webSearchCount: 'WebSearch',
}
const NON_TOOL_COUNTS = new Set(['toolUseCount'])
function toolsFromStats(stats) {
  const out = {}
  if (!stats) return out
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v !== 'number' || v <= 0 || !k.endsWith('Count') || NON_TOOL_COUNTS.has(k)) continue
    const name = STAT_TO_TOOL[k] || k.replace(/Count$/, '')
    out[name] = (out[name] || 0) + v
  }
  return out
}

// Cuenta, recursivamente, pasos cuyos flags están en `set` (p.ej. error/retry).
function countFlagsDeep(steps, set) {
  let n = 0
  for (const s of steps || []) {
    for (const f of s.flags || []) if (set.has(f)) n++
    if (s.kind === 'agent' && s.agent?.steps?.length) n += countFlagsDeep(s.agent.steps, set)
  }
  return n
}

const ERROR_SET = new Set(['error'])
const RETRY_SET = new Set(['retry'])

function collectAgents(steps, out, depth = 0) {
  for (const s of steps) {
    if (s.kind === 'agent' && s.agent) {
      out.push({
        name: s.agent.name,
        id: s.agent.id,
        model: s.agent.model,
        depth,
        tokens: s.agent.totalTokens || 0,
        durationMs: s.durationMs || s.agent.durationMs || null,
        stats: s.agent.stats || null,
        tools: toolsFromStats(s.agent.stats),
        errors: countFlagsDeep(s.agent.steps, ERROR_SET),
        retries: countFlagsDeep(s.agent.steps, RETRY_SET),
        flags: s.flags || [],
      })
      if (s.agent.steps?.length) collectAgents(s.agent.steps, out, depth + 1)
    }
  }
}

// Cuenta skills por nombre y registra CÓMO se invocaron (tool Skill, slash-command
// o ejecutando su script vía Bash). `acc` es un Map name -> {name,count,via:Set}.
function collectSkills(steps, acc) {
  const bump = (name, via) => {
    if (!name) return
    const e = acc.get(name) || { name, count: 0, via: new Set() }
    e.count += 1
    e.via.add(via)
    acc.set(name, e)
  }
  for (const s of steps) {
    if (s.kind === 'skill' && s.label) {
      if (s.label.startsWith('comando:')) bump(s.label.replace(/^comando:\/?/, ''), 'command')
      else bump(s.label.replace(/^skill:/, ''), 'skill-tool')
    }
    if (s.skill && s.skill.name) bump(s.skill.name, s.skill.via || 'bash')
    if (s.kind === 'agent' && s.agent?.steps?.length) collectSkills(s.agent.steps, acc)
  }
}

// Desglose por turno (granularidad REAL de los tokens). Un turno = una respuesta
// del LLM; el log no atribuye coste por herramienta, solo por turno. NO inventamos
// reparto: mostramos el coste del turno y QUÉ herramientas corrió dentro.
function collectTurns(steps) {
  const map = new Map()
  for (const s of steps) {
    if (s.turn == null) continue
    let t = map.get(s.turn)
    if (!t) {
      t = { turn: s.turn, tokens: null, model: s.model || null, kinds: {}, tools: [] }
      map.set(s.turn, t)
    }
    if (s.tokens && !t.tokens) t.tokens = s.tokens
    if (!t.model && s.model) t.model = s.model
    t.kinds[s.kind] = (t.kinds[s.kind] || 0) + 1
    if (s.kind === 'tool_call' || s.kind === 'agent' || s.kind === 'skill') t.tools.push(s.label)
  }
  return [...map.values()].sort((a, b) => a.turn - b.turn)
}

function collectDecisions(steps, out) {
  for (const s of steps) {
    if (s.kind === 'decision' && s.decision) {
      out.push({
        index: s.index,
        kind: s.decision.kind,
        prompt: s.decision.prompt,
        options: s.decision.options || null,
        chosen: s.decision.chosen || null,
        interrupted: !!s.decision.interrupted,
      })
    }
    if (s.kind === 'agent' && s.agent?.steps?.length) collectDecisions(s.agent.steps, out)
  }
}

function countKinds(steps, counts) {
  for (const s of steps) {
    counts[s.kind] = (counts[s.kind] || 0) + 1
    if (s.kind === 'agent' && s.agent?.steps?.length) countKinds(s.agent.steps, counts)
  }
}

function countBy(arr, fn) {
  const out = {}
  for (const x of arr) {
    const k = fn(x)
    out[k] = (out[k] || 0) + 1
  }
  return out
}

export function enrich(trace, opts = {}) {
  const steps = trace.steps || []
  const criteria = opts.criteria || loadCriteria()
  const baselines = opts.baselines || null

  const agentDurations = []
  const agentTokens = []
  const collectAgentMetrics = ss => {
    for (const s of ss) {
      if (s.kind === 'agent' && s.agent) {
        if (s.durationMs) agentDurations.push(s.durationMs)
        if (s.agent.totalTokens) agentTokens.push(s.agent.totalTokens)
        if (s.agent.steps?.length) collectAgentMetrics(s.agent.steps)
      }
    }
  }
  collectAgentMetrics(steps)
  const minP90 = criteria.p90.minSamples
  const durP90 = agentDurations.length >= minP90 ? percentile(agentDurations, 90) : Infinity
  const tokP90 = agentTokens.length >= minP90 ? percentile(agentTokens, 90) : Infinity

  const findings = []
  flagSteps(steps, { criteria, baselines, durP90, tokP90 }, findings)

  trace.tokens = sumTokens(steps)

  const stepCounts = {}
  countKinds(steps, stepCounts)
  const agents = []
  collectAgents(steps, agents)
  const skillAcc = new Map()
  collectSkills(steps, skillAcc)
  const decisions = []
  collectDecisions(steps, decisions)
  const turns = collectTurns(steps)

  trace.summary = {
    stepCounts,
    tokens: trace.tokens,
    durationMs:
      trace.startedAt && trace.endedAt
        ? Date.parse(trace.endedAt) - Date.parse(trace.startedAt)
        : null,
    agents,
    skills: [...skillAcc.values()]
      .map(e => ({ name: e.name, count: e.count, via: [...e.via] }))
      .sort((a, b) => b.count - a.count),
    turns,
    decisions,
    findings, // "tramos a revisar" (mecánicos; el judge añade los de calidad)
    findingsByCategory: countBy(findings, f => f.category),
    models: trace.models || [],
  }
  return trace
}

// Mezcla los hallazgos de calidad (del LLM-judge) en summary.findings.
// verdicts: [{ index, path?, severity, why, recommendation? }]
export function mergeQualityFindings(trace, verdicts) {
  if (!trace.summary) return trace
  for (const v of verdicts || []) {
    if (!v || v.real === false) continue
    trace.summary.findings.push({
      index: v.index ?? null,
      path: v.path || '',
      kind: v.kind || 'message',
      label: v.label || 'calidad',
      flags: ['calidad'],
      category: 'calidad',
      severity: v.severity || 'media',
      why: v.why || '',
      recommendation: v.recommendation || null,
      source: 'judge',
    })
  }
  trace.summary.findingsByCategory = countBy(trace.summary.findings, f => f.category)
  return trace
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
}
function stddev(arr) {
  if (arr.length < 2) return 0
  const m = mean(arr)
  return Math.sqrt(mean(arr.map(x => (x - m) ** 2)))
}

// Dashboard cross-sesión: agrega varias trazas ya enriquecidas.
// Devuelve también `baselines` (media/σ/p90 por agente) para alimentar el
// criterio híbrido por línea base; el llamador decide si persistirlo.
export function aggregate(traces) {
  const agentTotals = new Map()
  const skillTotals = new Map()
  const agentTimeline = new Map() // nombre -> [puntos por sesión] (serie temporal)
  let decisions = 0
  let findings = 0
  let tokens = 0
  const sessions = traces.map(t => {
    tokens += t.tokens?.total || 0
    decisions += t.summary?.decisions?.length || 0
    findings += t.summary?.findings?.length || 0
    for (const a of t.summary?.agents || []) {
      const r =
        agentTotals.get(a.name) ||
        { tokens: 0, calls: 0, durationMs: 0, tokensArr: [], durArr: [], tools: {}, errors: 0, retries: 0, toolUses: 0, sessions: new Set() }
      r.tokens += a.tokens || 0
      r.calls += 1
      r.durationMs += a.durationMs || 0
      if (a.tokens) r.tokensArr.push(a.tokens)
      if (a.durationMs) r.durArr.push(a.durationMs)
      for (const [tool, n] of Object.entries(a.tools || {})) {
        r.tools[tool] = (r.tools[tool] || 0) + n
        r.toolUses += n
      }
      r.errors += a.errors || 0
      r.retries += a.retries || 0
      r.sessions.add(t.sessionId)
      agentTotals.set(a.name, r)
    }
    // serie temporal: un punto por (agente, sesión), agregando sus invocaciones
    // dentro de la sesión. Alimenta el drill-down "agente en el tiempo".
    const perAgent = new Map()
    for (const a of t.summary?.agents || []) {
      const e = perAgent.get(a.name) || { tokens: 0, durationMs: 0, errors: 0, retries: 0, calls: 0, toolUses: 0 }
      e.tokens += a.tokens || 0
      e.durationMs += a.durationMs || 0
      e.errors += a.errors || 0
      e.retries += a.retries || 0
      e.calls += 1
      for (const n of Object.values(a.tools || {})) e.toolUses += n
      perAgent.set(a.name, e)
    }
    for (const [name, e] of perAgent) {
      const arr = agentTimeline.get(name) || []
      arr.push({
        sessionId: t.sessionId,
        title: t.title,
        startedAt: t.startedAt,
        tokens: e.tokens,
        durationMs: e.durationMs,
        errors: e.errors,
        retries: e.retries,
        calls: e.calls,
        toolUses: e.toolUses,
        errorRate: e.toolUses ? e.errors / e.toolUses : 0,
      })
      agentTimeline.set(name, arr)
    }
    for (const s of t.summary?.skills || []) {
      skillTotals.set(s.name, (skillTotals.get(s.name) || 0) + s.count)
    }
    return {
      source: t.source,
      sessionId: t.sessionId,
      title: t.title,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      tokens: t.tokens?.total || 0,
      steps: Object.values(t.summary?.stepCounts || {}).reduce((a, b) => a + b, 0),
      agents: t.summary?.agents?.length || 0,
      decisions: t.summary?.decisions?.length || 0,
      findings: t.summary?.findings?.length || 0,
      findingsByCategory: t.summary?.findingsByCategory || {},
    }
  })

  const byAgent = [...agentTotals.entries()]
    .map(([name, r]) => ({
      name,
      calls: r.calls,
      sessions: r.sessions.size,
      tokens: r.tokens,
      tokensAvg: r.calls ? Math.round(r.tokens / r.calls) : 0,
      tokensP90: r.tokensArr.length ? Math.round(percentile(r.tokensArr, 90)) : 0,
      durationMs: r.durationMs,
      durationAvg: r.calls ? Math.round(r.durationMs / r.calls) : 0,
      errors: r.errors,
      retries: r.retries,
      // fracción de usos de herramienta que dieron error (0..1); 0 si no hubo usos
      errorRate: r.toolUses ? r.errors / r.toolUses : 0,
      tools: Object.entries(r.tools)
        .map(([tool, count]) => ({ name: tool, count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.tokens - a.tokens)

  // baselines por agente para el criterio híbrido (Hilo B)
  const baselines = {}
  for (const [name, r] of agentTotals.entries()) {
    baselines[name] = {
      tokens: { mean: mean(r.tokensArr), std: stddev(r.tokensArr), p90: r.tokensArr.length ? percentile(r.tokensArr, 90) : 0, samples: r.tokensArr.length },
      durationMs: { mean: mean(r.durArr), std: stddev(r.durArr), p90: r.durArr.length ? percentile(r.durArr, 90) : 0, samples: r.durArr.length },
    }
  }

  return {
    generatedFrom: traces.length,
    totals: { tokens, decisions, findings, sessions: traces.length },
    byAgent,
    bySkill: [...skillTotals.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    sessions: sessions.sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || '')),
    baselines,
    // serie temporal por agente, ordenada cronológicamente
    agentTimeline: Object.fromEntries(
      [...agentTimeline.entries()].map(([name, pts]) => [
        name,
        pts.sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || '')),
      ]),
    ),
  }
}

export default { enrich, aggregate, mergeQualityFindings }
