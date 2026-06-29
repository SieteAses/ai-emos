'use strict'
/**
 * lib.js — helpers puros de la extensión (sin dependencia de `vscode`),
 * para poder testearlos con node directamente.
 */

const crypto = require('crypto')

const fmtTok = n =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0)

const makeNonce = () => crypto.randomBytes(16).toString('hex')

// Evita cerrar el <script> con </script> dentro del JSON embebido.
function escapeForScript(json) {
  return json.replace(/<\/script>/gi, '<\\/script>')
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
// Inyecta los datos DESPUÉS de esto (el JSON puede contener "<script" y no debe
// recibir nonce).
function prepareWebview(template, nonce, opts = {}) {
  const saveButton = opts.saveButton !== false
  const findingsButton = !!opts.findingsButton
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
    const lbl = '⚑ Tramos a revisar' + (n != null ? ` (${n})` : '')
    const find =
      `<button id="__avfind" title="Ver tramos a revisar" ` +
      `style="position:fixed;right:16px;bottom:56px;z-index:60;background:#ffb86b;color:#0b0d11;` +
      `border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font:600 13px ui-sans-serif,system-ui,sans-serif;` +
      `box-shadow:0 4px 14px rgba(0,0,0,.45)">${lbl}</button>` +
      `<script nonce="${nonce}">(function(){var b=document.getElementById('__avfind');` +
      `if(b&&window.__vscodeApi)b.onclick=function(){window.__vscodeApi.postMessage({type:'open-findings'});};})();</script>`
    html = html.replace('</body>', () => find + '\n</body>')
  }

  if (saveButton) {
    const save =
      `<button id="__avsave" title="Guardar reporte HTML" ` +
      `style="position:fixed;right:16px;bottom:14px;z-index:60;background:#6ea8fe;color:#0b0d11;` +
      `border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font:600 13px ui-sans-serif,system-ui,sans-serif;` +
      `box-shadow:0 4px 14px rgba(0,0,0,.45)">💾 Guardar</button>` +
      `<script nonce="${nonce}">(function(){var b=document.getElementById('__avsave');` +
      `if(b&&window.__vscodeApi)b.onclick=function(){window.__vscodeApi.postMessage({type:'save'});};})();</script>`
    html = html.replace('</body>', () => save + '\n</body>')
  }
  return html
}

module.exports = { fmtTok, makeNonce, escapeForScript, buildHtml, prepareWebview }
