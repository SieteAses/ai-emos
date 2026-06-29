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
const { buildHtml, prepareWebview, makeNonce, fmtTok } = require('./lib')

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
  return { adapters, render }
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
  const standalone = buildHtml(template, data) // HTML self-contained (lo que se guarda)
  const panel = makePanel(title, opts.column)
  panel.webview.html = buildHtml(
    prepareWebview(template, makeNonce(), {
      saveButton: true,
      findingsButton: opts.findingsButton,
      findingsCount: opts.findingsCount,
    }),
    data,
  )
  panel.webview.onDidReceiveMessage(async msg => {
    if (!msg) return
    if (msg.type === 'save') {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(cwd(), defaultName)),
        filters: { 'HTML self-contained': ['html'] },
      })
      if (uri) {
        fs.writeFileSync(uri.fsPath, standalone)
        vscode.window.showInformationMessage('ai-emos: guardado en ' + uri.fsPath)
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
    findingsPanel = openReport(trace, 'findings.html', `Tramos a revisar · ${label}`, findingsName, {
      column: vscode.ViewColumn.Beside,
    })
    findingsPanel.onDidDispose(() => {
      findingsPanel = null
    })
  }
  return openReport(trace, 'timeline.html', `Timeline · ${label}`, timelineName, {
    findingsButton: findingsCount > 0,
    findingsCount,
    onOpenFindings,
  })
}

async function openTimelineForSession(sess) {
  const { adapters, render } = await loadCore()
  await withProgress('ai-emos: parseando sesión…', async () => {
    const trace = render.enrich(await adapters.parse({ session: sess.file || sess.sessionId }))
    const label = sess.title || sess.sessionId
    openTimelineReport(
      trace,
      label,
      `session-timeline-${sess.sessionId}.html`,
      `session-findings-${sess.sessionId}.html`,
    )
  })
}

// Vista UNIFICADA: lista paginada de sesiones (rápida) + agregados bajo demanda.
// Clic en una sesión → abre su timeline en pestaña nueva.
// "Analizar agregados" → parsea las sesiones del filtro y devuelve byAgent/bySkill.
async function cmdSessions() {
  const { adapters, render } = await loadCore()
  const rows = await withProgress('ai-emos: listando sesiones…', () => adapters.listSessions({}))
  if (!rows.length) {
    vscode.window.showWarningMessage('ai-emos: no encontré sesiones en ~/.claude/projects.')
    return
  }
  const template = fs.readFileSync(path.join(ASSETS, 'sessions.html'), 'utf8')
  const panel = makePanel('ai-emos · Sesiones')
  panel.webview.html = buildHtml(prepareWebview(template, makeNonce(), { saveButton: false }), { sessions: rows })
  panel.webview.onDidReceiveMessage(async msg => {
    if (!msg) return
    if (msg.type === 'open') {
      const r = rows.find(x => x.sessionId === msg.id) || {}
      await openTimelineForSession({ sessionId: msg.id, file: msg.file || r.file, title: r.title })
    } else if (msg.type === 'aggregate') {
      const ids = new Set(msg.ids || [])
      const subset = rows.filter(r => ids.has(r.sessionId))
      await withProgress(`ai-emos: analizando ${subset.length} sesiones…`, async () => {
        const traces = []
        for (const r of subset) {
          try {
            traces.push(render.enrich(await adapters.parse({ session: r.file || r.sessionId })))
          } catch {
            /* salta sesiones ilegibles */
          }
        }
        panel.webview.postMessage({ type: 'aggregateResult', data: render.aggregate(traces) })
      })
    }
  })
}

async function cmdOpenFile() {
  const picks = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Visualizar',
    filters: { 'Trazas (NDJSON/OTel/JSON/JSONL)': ['ndjson', 'json', 'jsonl'] },
  })
  if (!picks || !picks.length) return
  const file = picks[0].fsPath
  const { adapters, render } = await loadCore()
  await withProgress('ai-emos: parseando archivo…', async () => {
    try {
      const trace = render.enrich(await adapters.parse({ session: file }))
      const base = path.basename(file).replace(/\.[^.]+$/, '')
      openTimelineReport(trace, path.basename(file), base + '-timeline.html', base + '-findings.html')
    } catch (e) {
      vscode.window.showErrorMessage('ai-emos: no pude parsear el archivo. ' + (e && e.message))
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
  if (route === 'timeline') {
    const file = q.get('file')
    const session = q.get('session')
    if (file) return openTimelineForSession({ sessionId: path.basename(file).replace(/\.[^.]+$/, ''), file })
    if (session) return openTimelineForSession({ sessionId: session })
  }
  vscode.window.showWarningMessage('ai-emos: URI no reconocida → ' + uri.toString())
}

function err(e) {
  vscode.window.showErrorMessage('ai-emos: ' + (e && e.stack ? e.stack : e))
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('aiEmos.sessions', () => cmdSessions().catch(err)),
    vscode.commands.registerCommand('aiEmos.openFile', () => cmdOpenFile().catch(err)),
    // alias de compatibilidad
    vscode.commands.registerCommand('aiEmos.visualizeSession', () => cmdSessions().catch(err)),
    // handoff desde agentes/chats vía deep link
    vscode.window.registerUriHandler({ handleUri: uri => handleUri(uri).catch(err) }),
  )
}
function deactivate() {}

module.exports = { activate, deactivate }
