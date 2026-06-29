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

const COLD_CACHE_MIN_INPUT = 50000

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

// Marca flags por paso y acumula findings (con ruta legible).
function flagSteps(steps, durP90, tokP90, findings, pathLabel = '') {
  const prevByLabel = new Map() // label -> hubo error en la última aparición

  steps.forEach(s => {
    const flags = new Set(s.flags || [])

    if (s.io && s.io.isError) flags.add('error')

    if ((s.kind === 'tool_call' || s.kind === 'agent') && s.label) {
      if (prevByLabel.get(s.label)) flags.add('retry')
      prevByLabel.set(s.label, !!(s.io && s.io.isError))
    }

    if (s.kind === 'agent' && s.agent) {
      if (s.durationMs && s.durationMs >= durP90 && isFinite(durP90)) flags.add('slow')
      const tk = s.agent.totalTokens || 0
      if (tk && tk >= tokP90 && isFinite(tokP90)) flags.add('expensive')
    }

    if (s.tokens) {
      const { input = 0, cacheRead = 0 } = s.tokens
      if (input > COLD_CACHE_MIN_INPUT && input > cacheRead) flags.add('cold-cache')
    }

    if (s.decision && s.decision.interrupted) flags.add('interrupted')

    s.flags = [...flags]

    if (s.flags.length) {
      const metas = s.flags.map(f => FLAG_META[f]).filter(Boolean)
      if (metas.length) {
        const sevRank = { alta: 3, media: 2, baja: 1 }
        const top = metas.reduce((a, b) => (sevRank[b.severity] > sevRank[a.severity] ? b : a))
        findings.push({
          index: s.index,
          path: pathLabel,
          kind: s.kind,
          label: s.label,
          flags: s.flags,
          category: top.category,
          severity: top.severity,
          why: metas.map(m => m.why).join('; '),
          source: 'mecanico',
        })
      }
    }

    if (s.kind === 'agent' && s.agent && s.agent.steps?.length) {
      flagSteps(s.agent.steps, durP90, tokP90, findings, `${pathLabel}${s.label} › `)
    }
  })
}

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

export function enrich(trace) {
  const steps = trace.steps || []

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
  const durP90 = agentDurations.length > 2 ? percentile(agentDurations, 90) : Infinity
  const tokP90 = agentTokens.length > 2 ? percentile(agentTokens, 90) : Infinity

  const findings = []
  flagSteps(steps, durP90, tokP90, findings)

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

// Dashboard cross-sesión: agrega varias trazas ya enriquecidas.
export function aggregate(traces) {
  const agentTotals = new Map()
  const skillTotals = new Map()
  let decisions = 0
  let findings = 0
  let tokens = 0
  const sessions = traces.map(t => {
    tokens += t.tokens?.total || 0
    decisions += t.summary?.decisions?.length || 0
    findings += t.summary?.findings?.length || 0
    for (const a of t.summary?.agents || []) {
      const r = agentTotals.get(a.name) || { tokens: 0, calls: 0, durationMs: 0 }
      r.tokens += a.tokens || 0
      r.calls += 1
      r.durationMs += a.durationMs || 0
      agentTotals.set(a.name, r)
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
  return {
    generatedFrom: traces.length,
    totals: { tokens, decisions, findings, sessions: traces.length },
    byAgent: [...agentTotals.entries()]
      .map(([name, r]) => ({ name, ...r }))
      .sort((a, b) => b.tokens - a.tokens),
    bySkill: [...skillTotals.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    sessions: sessions.sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || '')),
  }
}

export default { enrich, aggregate, mergeQualityFindings }
