/**
 * core/judge.mjs — LLM-as-judge OPCIONAL y BACKEND-AGNÓSTICO.
 *
 * Detecta "tramos a revisar" de categoría `calidad` (lo que las señales
 * mecánicas no pueden ver: respuestas mediocres, razonamiento flojo, etc.).
 *
 * NO asume que tengas una API de pago. Tres backends:
 *
 *  1. harness  (DEFECTO): el script NO llama a ningún LLM. Solo emite
 *     `judgeCandidates` en el JSON; la skill `visualize-session` los evalúa
 *     usando EL MODELO DEL CHAT que la llamó (sub-agentes vía la tool Agent).
 *     Cero key, cero tokens de API extra — usa tu suscripción.
 *
 *  2. local: endpoint OpenAI-compatible local (Ollama, LM Studio, llama.cpp).
 *     Sin key, sin costo. p.ej. http://localhost:11434/v1
 *
 *  3. api: endpoint con key (Anthropic u OpenAI-compatible), solo si la tienes.
 *
 * El núcleo solo necesita una función `complete(system, user) => Promise<string>`.
 * Las fábricas de backend de abajo construyen esa función; el CLI elige cuál.
 */

const MAX_SEG_CHARS = 2000

// ---------------------------------------------------------------------------
// Selección de candidatos (compartida por TODOS los modos)
// ---------------------------------------------------------------------------
// Devuelve segmentos que vale la pena juzgar por calidad: respuestas del
// asistente, resultados de sub-agente y pasos ya marcados mecánicamente
// (para ver si además hay un problema de calidad detrás del síntoma).
export function selectCandidates(trace, { max = 40 } = {}) {
  const out = []
  const walk = (steps, path = '') => {
    for (const s of steps) {
      if (out.length >= max) return
      if (s.kind === 'message' && s.role === 'assistant' && s.text) {
        out.push(cand(s, path, 'respuesta del asistente', s.text))
      } else if (s.kind === 'agent' && s.agent) {
        const outp = s.io && s.io.output
        if (outp) out.push(cand(s, path, `salida del sub-agente ${s.agent.name || ''}`, outp))
        if (s.agent.steps?.length) walk(s.agent.steps, `${path}${s.label} › `)
      } else if (s.kind === 'decision' && s.decision) {
        // un punto de decisión humana es candidato: ¿la IA planteó bien las opciones?
        out.push(cand(s, path, 'punto de decisión humana', s.decision.prompt || ''))
      }
    }
  }
  walk(trace.steps || [])
  return out
}

function cand(step, path, label, text) {
  const t = String(text || '')
  return {
    index: step.index,
    path,
    kind: step.kind,
    label,
    flags: step.flags || [], // señales mecánicas del paso, como contexto para el judge
    text: t.length > MAX_SEG_CHARS ? t.slice(0, MAX_SEG_CHARS) + '…' : t,
  }
}

// ---------------------------------------------------------------------------
// Prompt + parseo
// ---------------------------------------------------------------------------
export const JUDGE_SYSTEM =
  'Eres un evaluador de calidad de trabajo de un asistente de IA. Te dan ' +
  'segmentos de una sesión. Para cada uno, decide si hubo un problema de ' +
  'CALIDAD que valga la pena revisar e iterar (respuesta incompleta, ' +
  'razonamiento flojo, supuesto no verificado, se saltó un paso, ambiguo, ' +
  'opciones mal planteadas). NO marques cosas de costo/latencia/errores de ' +
  'tool (eso ya se detecta aparte). ' +
  'Rúbrica de severidad: "alta" = el resultado es incorrecto o engañoso, hay ' +
  'que rehacerlo; "media" = sirve pero es flojo, conviene iterar; "baja" = ' +
  'matiz menor, mejora opcional. ' +
  'Si un segmento trae "señales mecánicas" (fue caro/lento/falló), úsalas SOLO ' +
  'como contexto para confirmar o descartar un problema de calidad detrás del ' +
  'síntoma; no las repitas como hallazgo. Responde SOLO con JSON.'

export function buildJudgePrompt(candidates) {
  const items = candidates
    .map(c => {
      // adjunta las señales mecánicas del paso (si las hay) como contexto
      const sig = c.flags && c.flags.length ? `\n(señales mecánicas: ${c.flags.join(', ')})` : ''
      return `--- segmento index=${c.index} (${c.label}) ---${sig}\n${c.text}`
    })
    .join('\n\n')
  return (
    'Evalúa estos segmentos. Devuelve un objeto JSON con la forma ' +
    '{"verdicts":[{"index":<int>,"real":<bool>,"severity":"alta|media|baja",' +
    '"why":"<1 frase>","recommendation":"<1 frase o null>"}]}. ' +
    'Incluye SOLO los segmentos con un problema real de calidad (real=true).\n\n' +
    items
  )
}

export function parseVerdicts(text, candidates) {
  if (!text) return []
  let obj
  try {
    // tolerante: extrae el primer bloque JSON
    const m = text.match(/\{[\s\S]*\}/)
    obj = JSON.parse(m ? m[0] : text)
  } catch {
    return []
  }
  const arr = Array.isArray(obj) ? obj : obj.verdicts || []
  const byIndex = new Map(candidates.map(c => [c.index, c]))
  return arr
    .filter(v => v && v.real !== false)
    .map(v => {
      const c = byIndex.get(v.index) || {}
      return {
        index: v.index,
        path: c.path || '',
        kind: c.kind || 'message',
        label: 'calidad',
        real: true,
        severity: ['alta', 'media', 'baja'].includes(v.severity) ? v.severity : 'media',
        why: v.why || 'problema de calidad',
        recommendation: v.recommendation || null,
      }
    })
}

// Ejecuta el judge con un `complete(system, user) => Promise<string>` dado.
// Trocea en lotes para no exceder contextos chicos (modelos locales).
export async function runJudge(candidates, complete, { batch = 8 } = {}) {
  const verdicts = []
  for (let i = 0; i < candidates.length; i += batch) {
    const chunk = candidates.slice(i, i + batch)
    const text = await complete(JUDGE_SYSTEM, buildJudgePrompt(chunk))
    verdicts.push(...parseVerdicts(text, chunk))
  }
  return verdicts
}

// ---------------------------------------------------------------------------
// Backends opcionales (el CLI elige; el modo `harness` no usa ninguno)
// ---------------------------------------------------------------------------

// OpenAI-compatible (Ollama, LM Studio, llama.cpp, OpenAI, etc.).
// endpoint: base URL que termina en /v1 ; apiKey opcional (local no la necesita).
export function makeOpenAIBackend({ endpoint, model, apiKey }) {
  const url = endpoint.replace(/\/$/, '') + '/chat/completions'
  return async (system, user) => {
    const headers = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        max_tokens: 1500,
      }),
    })
    if (!res.ok) throw new Error(`judge ${endpoint}: HTTP ${res.status} ${await res.text()}`)
    const j = await res.json()
    return j.choices?.[0]?.message?.content || ''
  }
}

// Anthropic Messages API (solo si tienes key — no es el camino para suscripción).
export function makeAnthropicBackend({ model, apiKey, endpoint = 'https://api.anthropic.com' }) {
  return async (system, user) => {
    const res = await fetch(endpoint.replace(/\/$/, '') + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    })
    if (!res.ok) throw new Error(`judge anthropic: HTTP ${res.status} ${await res.text()}`)
    const j = await res.json()
    return (j.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
  }
}

export default {
  selectCandidates,
  runJudge,
  makeOpenAIBackend,
  makeAnthropicBackend,
  parseVerdicts,
  buildJudgePrompt,
  JUDGE_SYSTEM,
}
