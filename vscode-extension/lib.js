'use strict'
/**
 * lib.js — helpers puros de la extensión (sin dependencia de `vscode`),
 * para poder testearlos con node directamente.
 */

const crypto = require('crypto')

const fmtTok = n =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0)

const makeNonce = () => crypto.randomBytes(16).toString('hex')

// ---- i18n de la extensión (ES por defecto; EN si la locale de VS Code lo es) ----
// Fuente única de los textos en runtime + de los botones inyectados al webview.
const I18N = {
  es: {
    save: '💾 Guardar',
    saveTitle: 'Guardar reporte HTML',
    saveFilter: 'HTML self-contained',
    savedAt: 'ai-emos: guardado en {0}',
    findings: '⚑ Tramos a revisar',
    findingsTitle: 'Ver tramos a revisar',
    findingsPanelTitle: 'Tramos a revisar · {0}',
    timelinePanelTitle: 'Timeline · {0}',
    sessionsPanelTitle: 'ai-emos · Sesiones',
    entityPanelTitle: 'ai-emos · {0}',
    live: 'EN VIVO',
    parsingSession: 'ai-emos: parseando sesión…',
    openingLive: 'ai-emos: abriendo sesión en vivo…',
    listingSessions: 'ai-emos: listando sesiones…',
    parsingFile: 'ai-emos: parseando archivo…',
    analyzingN: 'ai-emos: analizando {0} sesiones…',
    noSessions: 'ai-emos: no encontré sesiones en ~/.claude/projects.',
    pickLive: 'Elige una sesión para verla EN VIVO (se refresca al cambiar el archivo)',
    seeFindings: 'Ver tramos',
    moreN: ' (+{0} más)',
    segment: 'tramo',
    parseFailed: 'ai-emos: no pude parsear el archivo. {0}',
    openLabel: 'Visualizar',
    tracesFilter: 'Trazas (NDJSON/OTel/JSON/JSONL)',
    uriUnknown: 'ai-emos: URI no reconocida → {0}',
  },
  en: {
    save: '💾 Save',
    saveTitle: 'Save HTML report',
    saveFilter: 'Self-contained HTML',
    savedAt: 'ai-emos: saved to {0}',
    findings: '⚑ Segments to review',
    findingsTitle: 'View segments to review',
    findingsPanelTitle: 'Segments to review · {0}',
    timelinePanelTitle: 'Timeline · {0}',
    sessionsPanelTitle: 'ai-emos · Sessions',
    entityPanelTitle: 'ai-emos · {0}',
    live: 'LIVE',
    parsingSession: 'ai-emos: parsing session…',
    openingLive: 'ai-emos: opening live session…',
    listingSessions: 'ai-emos: listing sessions…',
    parsingFile: 'ai-emos: parsing file…',
    analyzingN: 'ai-emos: analyzing {0} sessions…',
    noSessions: 'ai-emos: no sessions found in ~/.claude/projects.',
    pickLive: 'Pick a session to watch LIVE (refreshes when the file changes)',
    seeFindings: 'View segments',
    moreN: ' (+{0} more)',
    segment: 'segment',
    parseFailed: 'ai-emos: could not parse the file. {0}',
    openLabel: 'Visualize',
    tracesFilter: 'Traces (NDJSON/OTel/JSON/JSONL)',
    uriUnknown: 'ai-emos: unrecognized URI → {0}',
  },
}

// Normaliza una locale de VS Code (p.ej. 'en', 'en-US', 'es', 'pt-br') a 'es'|'en'.
const pickLang = l => (String(l || '').toLowerCase().startsWith('en') ? 'en' : 'es')

// tr('es','savedAt', path) → texto con placeholders {0},{1}… reemplazados.
function tr(lang, key, ...args) {
  const L = I18N[lang] || I18N.es
  let s = L[key] != null ? L[key] : I18N.es[key] != null ? I18N.es[key] : key
  args.forEach((v, i) => {
    s = s.split('{' + i + '}').join(v)
  })
  return s
}

// Evita cerrar el <script> con </script> dentro del JSON embebido.
function escapeForScript(json) {
  return json.replace(/<\/script>/gi, '<\\/script>')
}

// Inyecta window.__lang ANTES de los scripts del template → fija el idioma por
// defecto del visor (el usuario puede cambiarlo con el toggle; persiste en
// localStorage). 'es'|'en'.
function injectLang(html, lang) {
  if (lang !== 'es' && lang !== 'en') return html
  const tag = `<script>window.__lang=${JSON.stringify(lang)};</script>`
  if (html.includes('<head>')) return html.replace('<head>', () => '<head>\n' + tag)
  return tag + html
}

// Inyecta los datos en el <script id="report-data"> del template.
// Regex TOLERANTE a atributos (p.ej. nonce) y reemplazo por FUNCIÓN (el JSON
// contiene `$` que String.replace interpretaría como retro-referencias).
function buildHtml(template, data) {
  const safe = escapeForScript(JSON.stringify(data))
  const re = /(<script\b[^>]*\bid="report-data"[^>]*>)([\s\S]*?)(<\/script>)/
  if (re.test(template)) return template.replace(re, (m, p1, _p2, p3) => p1 + '\n' + safe + '\n' + p3)
  return template.replace('</body>', () => `<script id="report-data" type="application/json">\n${safe}\n</script>\n</body>`)
}

// Adapta un template (SIN datos aún) para webview de VS Code:
//  - CSP con nonce (script-src 'nonce-…') — VS Code no ejecuta inline sin nonce
//  - bootstrap de acquireVsCodeApi() en <head> → window.__vscodeApi (1 sola vez)
//  - nonce en TODOS los <script>
//  - (opcional) botón flotante Guardar que postMessage({type:'save'})
//  - (opcional) botón flotante "Tramos a revisar" que postMessage({type:'open-findings'})
// opts.lang ('es'|'en') localiza los botones inyectados. Inyecta los datos
// DESPUÉS de esto (el JSON puede contener "<script" y no debe recibir nonce).
function prepareWebview(template, nonce, opts = {}) {
  const saveButton = opts.saveButton !== false
  const findingsButton = !!opts.findingsButton
  const lang = opts.lang === 'en' ? 'en' : 'es'
  const csp =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
    `style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: https:; font-src data:;">`
  const bootstrap = `<script>window.__vscodeApi=(function(){try{return acquireVsCodeApi();}catch(e){return null;}})();</script>`

  let html = template
  if (html.includes('<head>')) html = html.replace('<head>', () => '<head>\n' + csp + '\n' + bootstrap)
  else html = csp + bootstrap + html

  // nonce a todos los <script> del template + bootstrap (ANTES de inyectar datos)
  html = html.replace(/<script/g, () => `<script nonce="${nonce}"`)

  if (findingsButton) {
    const n = opts.findingsCount
    const lbl = tr(lang, 'findings') + (n != null ? ` (${n})` : '')
    const find =
      `<button id="__avfind" title="${tr(lang, 'findingsTitle')}" ` +
      `style="position:fixed;right:16px;bottom:56px;z-index:60;background:#ffb86b;color:#0b0d11;` +
      `border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font:600 13px ui-sans-serif,system-ui,sans-serif;` +
      `box-shadow:0 4px 14px rgba(0,0,0,.45)">${lbl}</button>` +
      `<script nonce="${nonce}">(function(){var b=document.getElementById('__avfind');` +
      `if(b&&window.__vscodeApi)b.onclick=function(){window.__vscodeApi.postMessage({type:'open-findings'});};})();</script>`
    html = html.replace('</body>', () => find + '\n</body>')
  }

  if (saveButton) {
    const save =
      `<button id="__avsave" title="${tr(lang, 'saveTitle')}" ` +
      `style="position:fixed;right:16px;bottom:14px;z-index:60;background:#6ea8fe;color:#0b0d11;` +
      `border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font:600 13px ui-sans-serif,system-ui,sans-serif;` +
      `box-shadow:0 4px 14px rgba(0,0,0,.45)">${tr(lang, 'save')}</button>` +
      `<script nonce="${nonce}">(function(){var b=document.getElementById('__avsave');` +
      `if(b&&window.__vscodeApi)b.onclick=function(){window.__vscodeApi.postMessage({type:'save'});};})();</script>`
    html = html.replace('</body>', () => save + '\n</body>')
  }
  return html
}

module.exports = { fmtTok, makeNonce, escapeForScript, buildHtml, prepareWebview, injectLang, pickLang, tr, I18N }
