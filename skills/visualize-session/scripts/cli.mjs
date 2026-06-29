#!/usr/bin/env node
/**
 * cli.mjs — CLI fino sobre core/ para la skill visualize-session.
 *
 * Es determinístico y NO llama a ningún LLM por defecto (modo judge=harness).
 * El historial nunca entra al contexto del modelo: este script parsea el
 * transcript y produce JSON / HTML.
 *
 * Uso:
 *   node cli.mjs --list [--adapter <a>] [--since 7d]
 *   node cli.mjs --session <id|path> [--adapter <a>] [--json] [--html out.html]
 *   node cli.mjs --dashboard [--adapter <a>] [--since 7d] [--json] [--html out.html]
 *
 * Judge de calidad (opcional, backend-agnóstico):
 *   --judge harness   (defecto si se pide --judge sin valor): NO llama LLM;
 *                      emite judgeCandidates para que la skill los evalúe con
 *                      el modelo del chat (sub-agentes). Cero key, cero costo API.
 *   --judge local --judge-endpoint http://localhost:11434/v1 --judge-model qwen2.5
 *   --judge api   --judge-format anthropic|openai --judge-model <m> \
 *                 --judge-endpoint <url> --judge-key-env ANTHROPIC_API_KEY
 */

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import adapters from '../../../core/adapters/index.mjs'
import { enrich, aggregate, mergeQualityFindings } from '../../../core/render.mjs'
import { loadCriteria, loadBaselines, saveBaselines } from '../../../core/criteria.mjs'
import judge from '../../../core/judge.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.join(__dirname, '..', 'assets')

function flag(name, dflt) {
  const i = process.argv.indexOf(name)
  if (i === -1) return dflt
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}
const has = name => process.argv.includes(name)

const EXT_ID = flag('--ext-id', 'ai-emos.ai-emos')

// ¿corremos dentro de VS Code? (terminal integrada / extension host)
function inVscode() {
  return (
    process.env.TERM_PROGRAM === 'vscode' ||
    !!process.env.VSCODE_PID ||
    !!process.env.VSCODE_IPC_HOOK_CLI ||
    !!process.env.VSCODE_GIT_IPC_HANDLE
  )
}

// Deep link que la extensión ai-emos atiende vía su UriHandler.
function buildDeepLink(session, adapter) {
  const isPath = session.includes('/') || /\.(jsonl|ndjson|json)$/.test(session)
  const params = new URLSearchParams()
  if (isPath) params.set('file', path.resolve(session))
  else params.set('session', session)
  if (adapter) params.set('source', adapter)
  return `vscode://${EXT_ID}/timeline?${params.toString()}`
}

function trySpawn(cmd, args) {
  return new Promise(res => {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore', detached: true })
      p.on('error', () => res(false))
      p.on('spawn', () => {
        p.unref()
        res(true)
      })
    } catch {
      res(false)
    }
  })
}

// Abre el deep link en VS Code (mejor esfuerzo, multiplataforma).
async function handoff(uri) {
  if (await trySpawn('code', ['--open-url', uri])) return true
  if (process.platform === 'darwin') return trySpawn('open', [uri])
  if (process.platform === 'win32') return trySpawn('cmd', ['/c', 'start', '', uri])
  return trySpawn('xdg-open', [uri])
}

// Carga los criterios efectivos (defaults ← config usuario ← .ai-emos.json ←
// --criteria <file>) una sola vez. El baseline por agente se lee aparte.
function resolveCriteria() {
  const file = flag('--criteria', null)
  let overrides = {}
  if (typeof file === 'string') {
    try {
      overrides = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      process.stderr.write(`--criteria: no pude leer ${file}: ${e.message}\n`)
    }
  }
  return loadCriteria(overrides)
}

async function main() {
  const adapter = flag('--adapter', null) || flag('--source', null)
  const since = flag('--since', null)
  const opts = { adapter, source: adapter, since }
  const criteria = resolveCriteria()
  const baselines = loadBaselines()

  if (has('--list')) {
    const rows = await adapters.listSessions(opts)
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
    return
  }

  // Servidor local en vivo: timeline (o dashboard) que se refresca solo vía SSE.
  if (has('--serve')) {
    const { serve } = await import('./server.mjs')
    const port = Number(flag('--port', null)) || 7878
    const session = flag('--session', null)
    const { url } = await serve({ port, session, dashboard: has('--dashboard'), adapter, source: adapter })
    process.stderr.write(`ai-emos: servidor en vivo → ${url}\n(ctrl-c para detener)\n`)
    if (flag('--open', null)) await handoff(url)
    return // mantiene el proceso vivo mientras el servidor escucha
  }

  if (has('--dashboard')) {
    const rows = await adapters.listSessions(opts)
    const traces = []
    for (const r of rows) {
      try {
        const t = await adapters.parse({ ...opts, session: r.file || r.sessionId })
        traces.push(enrich(t, { criteria, baselines }))
      } catch {
        /* salta sesiones ilegibles */
      }
    }
    const dash = aggregate(traces)
    // persiste el baseline recién calculado para alimentar el criterio híbrido
    const saved = saveBaselines(dash.baselines)
    if (saved) process.stderr.write(`ai-emos: baseline actualizado → ${saved}\n`)
    await output(dash, 'dashboard.html', typeof flag('--html', null) === 'string' ? flag('--html', null) : null)
    return
  }

  const session = flag('--session', null)
  if (!session) {
    process.stderr.write('Falta --session <id|path> (o usa --list / --dashboard).\n')
    process.exit(2)
  }

  // --open auto|vscode|html : dentro de VS Code, handoff a la extensión (panel
  // nativo); fuera (o si falla), genera HTML standalone.
  const openMode = flag('--open', null)
  let handedOff = false
  if (openMode && openMode !== 'html' && !has('--json')) {
    const wantVscode = openMode === 'vscode' || (openMode === 'auto' && inVscode())
    if (wantVscode) {
      const uri = buildDeepLink(session, adapter)
      if (has('--dry-run')) {
        process.stdout.write(uri + '\n')
        return
      }
      handedOff = await handoff(uri)
      if (handedOff) {
        process.stderr.write('ai-emos: abriendo en VS Code (extensión)…\n')
        return
      }
      process.stderr.write('ai-emos: handoff a VS Code falló; genero HTML standalone.\n')
    }
  }

  const trace = enrich(await adapters.parse({ ...opts, session }), { criteria, baselines })

  // judge de calidad opcional
  const judgeMode = flag('--judge', null)
  if (judgeMode) {
    const candidates = judge.selectCandidates(trace, { max: 40 })
    if (judgeMode === 'harness' || judgeMode === true) {
      // no llamamos LLM: exponemos candidatos para que la skill los evalúe
      trace.judgeCandidates = candidates
      trace.judgeMode = 'harness'
    } else {
      const complete = buildBackend(judgeMode)
      try {
        const verdicts = await judge.runJudge(candidates, complete)
        mergeQualityFindings(trace, verdicts)
        trace.judgeMode = judgeMode
      } catch (e) {
        process.stderr.write(`judge (${judgeMode}) falló: ${e.message}\n`)
        trace.judgeError = String(e.message)
      }
    }
  }

  const sid = String(session).replace(/[^\w.-]/g, '_').slice(0, 60)
  const timelineTarget = resolveHtmlTarget(`session-timeline-${sid}.html`, openMode)
  await output(trace, 'timeline.html', timelineTarget)
  // tramos a revisar en un HTML hermano (no JSON: solo cuando se escribe HTML)
  if (timelineTarget) {
    const findingsTarget = timelineTarget.replace(/\.html?$/i, '') + '-findings.html'
    await output(trace, 'findings.html', findingsTarget, true)
  }
}

// Decide a qué archivo escribir el HTML (o null = imprimir JSON).
function resolveHtmlTarget(defaultName, openMode) {
  const h = flag('--html', null)
  if (typeof h === 'string') return h
  if (openMode) return path.resolve(defaultName) // --open html / auto-fallback
  return null
}

function buildBackend(mode) {
  const model = flag('--judge-model', null)
  const endpoint = flag('--judge-endpoint', mode === 'local' ? 'http://localhost:11434/v1' : null)
  const keyEnv = flag('--judge-key-env', null)
  const apiKey = keyEnv ? process.env[keyEnv] : flag('--judge-key', null) || undefined
  const format = flag('--judge-format', 'openai')
  if (!model) throw new Error('--judge-model es requerido para judge local/api')
  if (format === 'anthropic') {
    if (!apiKey) throw new Error('judge api anthropic requiere --judge-key-env con la key')
    return judge.makeAnthropicBackend({ model, apiKey, endpoint: endpoint || 'https://api.anthropic.com' })
  }
  if (!endpoint) throw new Error('--judge-endpoint es requerido (OpenAI-compatible)')
  return judge.makeOpenAIBackend({ endpoint, model, apiKey })
}

async function output(data, templateName, htmlTarget, quietJson = false) {
  if (htmlTarget) {
    const tpl = fs.readFileSync(path.join(ASSETS, templateName), 'utf8')
    const json = JSON.stringify(data)
    fs.writeFileSync(htmlTarget, injectData(tpl, json))
    process.stderr.write(`ai-emos: HTML escrito → ${htmlTarget}\n`)
    if (has('--json') && !quietJson) process.stdout.write(json + '\n')
    return
  }
  process.stdout.write(JSON.stringify(data, null, has('--pretty') ? 2 : 0) + '\n')
}

// Reemplaza el contenido del <script id="report-data"> del template.
// IMPORTANTE: usar FUNCIÓN de reemplazo (no string) — el JSON contiene `$`
// (p.ej. "$schema", "$1", precios) que String.replace interpretaría como
// retro-referencias ($&, $1, $$) y corrompería el JSON.
function injectData(tpl, json) {
  const safe = escapeForScript(json)
  const re = /(<script id="report-data" type="application\/json">)([\s\S]*?)(<\/script>)/
  if (re.test(tpl)) return tpl.replace(re, (m, p1, _p2, p3) => p1 + '\n' + safe + '\n' + p3)
  return tpl.replace('</body>', () => `<script id="report-data" type="application/json">\n${safe}\n</script>\n</body>`)
}

// evita cerrar el <script> con </script> dentro del JSON
function escapeForScript(json) {
  return json.replace(/<\/script>/gi, '<\\/script>')
}

main().catch(e => {
  process.stderr.write(String(e && e.stack ? e.stack : e) + '\n')
  process.exit(1)
})
