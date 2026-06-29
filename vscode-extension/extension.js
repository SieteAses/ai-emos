'use strict'
/**
 * ai-emos — extensión de VS Code.
 *
 * Abre el timeline / dashboard de una sesión de IA en un webview de VS Code
 * (sin generar archivos salvo que el usuario pulse "Guardar"). Reutiliza el
 * mismo núcleo agnóstico (core/) y los templates HTML del repo.
 *
 * Extensión en JS plano (CommonJS) — sin paso de build. El núcleo es ESM y se
 * carga con import() dinámico desde el host de extensiones.
 */

const vscode = require('vscode')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const { buildHtml, prepareWebview, makeNonce, fmtTok, injectLang, pickLang, tr } = require('./lib')

// Idioma de la UI: sigue la locale de VS Code (ES por defecto, EN si lo es).
// El visor HTML permite además un toggle ES|EN que persiste en localStorage.
const LANG = pickLang(vscode.env.language)
const t = (key, ...args) => tr(LANG, key, ...args)

// Resuelve el núcleo/assets: usa la copia EMPAQUETADA (bundled/) si existe
// (.vsix self-contained), si no la del monorepo (dev con ../). Ver bundle.mjs.
function resolveBase() {
  const bundledCore = path.join(__dirname, 'bundled', 'core')
  if (fs.existsSync(bundledCore)) {
    return { CORE: bundledCore, ASSETS: path.join(__dirname, 'bundled', 'assets') }
  }
  return {
    CORE: path.join(__dirname, '..', 'core'),
    ASSETS: path.join(__dirname, '..', 'skills', 'visualize-session', 'assets'),
  }
}
const { CORE, ASSETS } = resolveBase()

async function loadCore() {
  const adapters = await import(pathToFileURL(path.join(CORE, 'adapters', 'index.mjs')).href)
  const render = await import(pathToFileURL(path.join(CORE, 'render.mjs')).href)
  const live = await import(pathToFileURL(path.join(CORE, 'live.mjs')).href)
  const criteria = await import(pathToFileURL(path.join(CORE, 'criteria.mjs')).href)
  return { adapters, render, live, criteria }
}

// Lee SOLO los settings que el usuario fijó de verdad (inspect: no defaults),
// para no pisar ~/.config/ai-emos/criteria.json con los valores por defecto.
function criteriaOverrides() {
  const c = vscode.workspace.getConfiguration('aiEmos.criteria')
  const o = {}
  const set = (dotted, val) => {
    if (val === undefined) return
    const ks = dotted.split('.')
    let t = o
    ks.slice(0, -1).forEach(k => (t = t[k] || (t[k] = {})))
    t[ks[ks.length - 1]] = val
  }
  const fixed = key => {
    const i = c.inspect(key)
    return i && (i.workspaceFolderValue ?? i.workspaceValue ?? i.globalValue)
  }
  for (const key of ['tokens.turnBudget', 'tokens.agentBudget', 'durationMs.tool', 'durationMs.agent', 'baseline.sigma']) {
    set(key, fixed(key))
  }
  return o
}

// { criteria, baselines } para pasar a render.enrich / live.watchSession.
function evalOptions(core) {
  return {
    criteria: core.criteria.loadCriteria(criteriaOverrides()),
    baselines: core.criteria.loadBaselines(),
  }
}

function cwd() {
  const ws = vscode.workspace.workspaceFolders
  return (ws && ws[0] && ws[0].uri.fsPath) || os.homedir()
}

function makePanel(title, column = vscode.ViewColumn.Active) {
  return vscode.window.createWebviewPanel('aiEmos', title, column, {
    enableScripts: true,
    retainContextWhenHidden: true,
  })
}

async function withProgress(title, fn) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn)
}

// Abre un reporte (timeline/dashboard/findings) en una pestaña nueva, con botón
// Guardar. opts: { column, findingsButton, findingsCount, onOpenFindings }.
function openReport(data, templateName, title, defaultName, opts = {}) {
  const template = fs.readFileSync(path.join(ASSETS, templateName), 'utf8')
  // HTML self-contained (lo que se guarda): fija el idioma actual por defecto.
  const standalone = injectLang(buildHtml(template, data), LANG)
  const panel = makePanel(title, opts.column)
  panel.webview.html = injectLang(
    buildHtml(
      prepareWebview(template, makeNonce(), {
        saveButton: true,
        findingsButton: opts.findingsButton,
        findingsCount: opts.findingsCount,
        lang: LANG,
      }),
      data,
    ),
    LANG,
  )
  panel.webview.onDidReceiveMessage(async msg => {
    if (!msg) return
    if (msg.type === 'save') {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(cwd(), defaultName)),
        filters: { [t('saveFilter')]: ['html'] },
      })
      if (uri) {
        fs.writeFileSync(uri.fsPath, standalone)
        vscode.window.showInformationMessage(t('savedAt', uri.fsPath))
      }
    } else if (msg.type === 'open-findings' && opts.onOpenFindings) {
      opts.onOpenFindings()
    }
  })
  return panel
}

// Abre el timeline con un botón "Tramos a revisar" que abre los findings en una
// pestaña al lado, bajo demanda (reusa la pestaña si ya está abierta).
function openTimelineReport(trace, label, timelineName, findingsName) {
  const findingsCount = ((trace.summary && trace.summary.findings) || []).length
  let findingsPanel = null
  const onOpenFindings = () => {
    if (findingsPanel) return findingsPanel.reveal(vscode.ViewColumn.Beside)
    findingsPanel = openReport(trace, 'findings.html', t('findingsPanelTitle', label), findingsName, {
      column: vscode.ViewColumn.Beside,
    })
    findingsPanel.onDidDispose(() => {
      findingsPanel = null
    })
  }
  const panel = openReport(trace, 'timeline.html', t('timelinePanelTitle', label), timelineName, {
    findingsButton: findingsCount > 0,
    findingsCount,
    onOpenFindings,
  })
  // Expone el abridor para que el modo en vivo pueda revelar los tramos desde
  // una notificación nativa de VS Code (botón "Ver tramos").
  panel.__openFindings = onOpenFindings
  return panel
}

// Notificación nativa: avisa de tramos a revisar que APARECIERON en vivo. Solo
// los de severidad alta (para no spamear); el resto se ve en el feed del panel.
// Agrupa el lote en un único toast con botón "Ver tramos".
function notifyLiveFindings(newFindings, panel) {
  const alta = (newFindings || []).filter(f => f && f.severity === 'alta')
  if (!alta.length) return
  const head = alta[0]
  const extra = alta.length > 1 ? t('moreN', alta.length - 1) : ''
  const what = `${head.category || t('segment')}: ${head.why || head.label || ''}`.trim()
  const seeFindings = t('seeFindings')
  vscode.window.showWarningMessage(`ai-emos · ${what}${extra}`, seeFindings).then(pick => {
    if (pick === seeFindings && panel && typeof panel.__openFindings === 'function') panel.__openFindings()
  })
}

async function openTimelineForSession(sess) {
  const core = await loadCore()
  const { adapters, render } = core
  await withProgress(t('parsingSession'), async () => {
    const trace = render.enrich(await adapters.parse({ session: sess.file || sess.sessionId }), evalOptions(core))
    const label = sess.title || sess.sessionId
    openTimelineReport(
      trace,
      label,
      `session-timeline-${sess.sessionId}.html`,
      `session-findings-${sess.sessionId}.html`,
    )
  })
}

// Abre el timeline de una sesión EN VIVO: observa su archivo (fs.watch nativo,
// cero deps) y empuja la traza re-parseada al webview por postMessage. El panel
// reaplica los datos sin recargar (window.__aiEmosApply en el template).
async function openLiveSession(sess) {
  const core = await loadCore()
  const { adapters, render, live } = core
  const ref = sess.file || sess.sessionId
  const ev = evalOptions(core)
  await withProgress(t('openingLive'), async () => {
    const trace = render.enrich(await adapters.parse({ session: ref }), ev)
    const label = (sess.title || sess.sessionId) + ' · ' + t('live')
    const panel = openTimelineReport(
      trace,
      label,
      `session-timeline-${sess.sessionId}.html`,
      `session-findings-${sess.sessionId}.html`,
    )
    const closer = await live.watchSession({ session: ref, ...ev }, (t, info) => {
      try {
        panel.webview.postMessage({ type: 'data', trace: t })
        const nf = (info && info.newFindings) || []
        if (nf.length) {
          // alimenta el feed en vivo del panel + actualiza el badge del botón
          panel.webview.postMessage({
            type: 'finding',
            findings: nf,
            total: ((t.summary && t.summary.findings) || []).length,
          })
          notifyLiveFindings(nf, panel) // toast nativo (solo severidad alta)
        }
      } catch {
        /* panel cerrado */
      }
    })
    panel.onDidDispose(() => closer())
  })
}

async function cmdLiveSession() {
  const { adapters } = await loadCore()
  const rows = await withProgress(t('listingSessions'), () => adapters.listSessions({}))
  if (!rows.length) {
    vscode.window.showWarningMessage(t('noSessions'))
    return
  }
  const pick = await vscode.window.showQuickPick(
    rows.slice(0, 100).map(r => ({ label: r.title || r.sessionId, description: r.sessionId, row: r })),
    { placeHolder: t('pickLive') },
  )
  if (!pick) return
  await openLiveSession({ sessionId: pick.row.sessionId, file: pick.row.file, title: pick.row.title })
}

// Vista UNIFICADA: lista paginada de sesiones (rápida) + agregados bajo demanda.
// Clic en una sesión → abre su timeline en pestaña nueva.
// "Analizar agregados" → parsea las sesiones del filtro y devuelve byAgent/bySkill.
async function cmdSessions() {
  const core = await loadCore()
  const { adapters, render, live } = core
  const ev = evalOptions(core)
  let rows = await withProgress(t('listingSessions'), () => adapters.listSessions({}))
  if (!rows.length) {
    vscode.window.showWarningMessage(t('noSessions'))
    return
  }
  const template = fs.readFileSync(path.join(ASSETS, 'sessions.html'), 'utf8')
  const panel = makePanel(t('sessionsPanelTitle'))
  panel.webview.html = injectLang(
    buildHtml(prepareWebview(template, makeNonce(), { saveButton: false, lang: LANG }), { sessions: rows }),
    LANG,
  )

  // Tabla EN VIVO: observa la raíz de sesiones de Claude Code (la fuente que
  // crece durante una sesión) y re-lista con debounce, empujando filas frescas.
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
  let relistTimer = null
  const closeWatch = live.defaultWatcher([projectsRoot], () => {
    clearTimeout(relistTimer)
    relistTimer = setTimeout(async () => {
      try {
        rows = await adapters.listSessions({})
        panel.webview.postMessage({ type: 'sessions', sessions: rows })
      } catch {
        /* re-listado fallido: el siguiente evento reintenta */
      }
    }, 400)
  })
  panel.onDidDispose(() => {
    clearTimeout(relistTimer)
    try {
      closeWatch()
    } catch {
      /* noop */
    }
  })

  panel.webview.onDidReceiveMessage(async msg => {
    if (!msg) return
    if (msg.type === 'open') {
      const r = rows.find(x => x.sessionId === msg.id) || {}
      // abre la sesión EN VIVO (panel que se refresca al cambiar el archivo)
      await openLiveSession({ sessionId: msg.id, file: msg.file || r.file, title: r.title })
    } else if (msg.type === 'aggregate') {
      const ids = new Set(msg.ids || [])
      const subset = rows.filter(r => ids.has(r.sessionId))
      await withProgress(t('analyzingN', subset.length), async () => {
        const traces = []
        for (const r of subset) {
          try {
            traces.push(render.enrich(await adapters.parse({ session: r.file || r.sessionId }), ev))
          } catch {
            /* salta sesiones ilegibles */
          }
        }
        const dash = render.aggregate(traces)
        core.criteria.saveBaselines(dash.baselines) // refresca el baseline por agente
        panel.webview.postMessage({ type: 'aggregateResult', data: dash })
      })
    }
  })
}

async function cmdOpenFile() {
  const picks = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: t('openLabel'),
    filters: { [t('tracesFilter')]: ['ndjson', 'json', 'jsonl'] },
  })
  if (!picks || !picks.length) return
  const file = picks[0].fsPath
  const core = await loadCore()
  const { adapters, render } = core
  await withProgress(t('parsingFile'), async () => {
    try {
      const trace = render.enrich(await adapters.parse({ session: file }), evalOptions(core))
      const base = path.basename(file).replace(/\.[^.]+$/, '')
      openTimelineReport(trace, path.basename(file), base + '-timeline.html', base + '-findings.html')
    } catch (e) {
      vscode.window.showErrorMessage(t('parseFailed', (e && e.message) || ''))
    }
  })
}

// Deep link desde un agente/chat (handoff): vscode://ai-emos.ai-emos/<ruta>?<query>
//   /timeline?session=<id>     → abre el timeline de esa sesión de Claude Code
//   /timeline?file=<ruta>      → abre el timeline de un archivo (otras fuentes)
//   /sessions                  → abre la lista unificada
async function handleUri(uri) {
  const route = (uri.path || '').replace(/^\/+/, '')
  const q = new URLSearchParams(uri.query || '')
  if (route === '' || route === 'sessions') return cmdSessions()
  if (route === 'timeline' || route === 'live') {
    const file = q.get('file')
    const session = q.get('session')
    const open = route === 'live' ? openLiveSession : openTimelineForSession
    if (file) return open({ sessionId: path.basename(file).replace(/\.[^.]+$/, ''), file })
    if (session) return open({ sessionId: session })
  }
  vscode.window.showWarningMessage(t('uriUnknown', uri.toString()))
}

function err(e) {
  vscode.window.showErrorMessage('ai-emos: ' + (e && e.stack ? e.stack : e))
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('aiEmos.sessions', () => cmdSessions().catch(err)),
    vscode.commands.registerCommand('aiEmos.openFile', () => cmdOpenFile().catch(err)),
    vscode.commands.registerCommand('aiEmos.liveSession', () => cmdLiveSession().catch(err)),
    // alias de compatibilidad
    vscode.commands.registerCommand('aiEmos.visualizeSession', () => cmdSessions().catch(err)),
    // handoff desde agentes/chats vía deep link
    vscode.window.registerUriHandler({ handleUri: uri => handleUri(uri).catch(err) }),
  )
}
function deactivate() {}

module.exports = { activate, deactivate }
