/**
 * server.mjs — servidor local opcional para ver una sesión EN VIVO.
 *
 * HTTP nativo (node:http), sin framework. Sirve los mismos templates que el
 * resto del proyecto y empuja la traza fresca por SSE (Server-Sent Events,
 * nativo en el navegador) cada vez que el archivo de la sesión cambia.
 *
 * Watcher: usa `chokidar` si está instalado (watch robusto multiplataforma);
 * si no, cae al `fs.watch` nativo de core/live.mjs. Así la dependencia es
 * OPCIONAL — el servidor funciona sin instalar nada.
 *
 * Lo arranca el CLI con `--serve`; ver cli.mjs.
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import adapters from '../../../core/adapters/index.mjs'
import { enrich, aggregate } from '../../../core/render.mjs'
import { loadCriteria, loadBaselines } from '../../../core/criteria.mjs'
import { watchSession, defaultWatcher } from '../../../core/live.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.join(__dirname, '..', 'assets')

// chokidar opcional → watcher; si falta, fs.watch nativo.
async function pickWatcher() {
  try {
    const { default: chokidar } = await import('chokidar')
    return (paths, onChange) => {
      const w = chokidar.watch(paths, { ignoreInitial: true })
      w.on('all', () => onChange())
      return () => w.close()
    }
  } catch {
    return defaultWatcher
  }
}

function escapeForScript(json) {
  return json.replace(/<\/script>/gi, '<\\/script>')
}

// Inyecta el JSON en el <script id="report-data"> del template.
function injectData(tpl, json) {
  const safe = escapeForScript(json)
  const re = /(<script id="report-data" type="application\/json">)([\s\S]*?)(<\/script>)/
  if (re.test(tpl)) return tpl.replace(re, (m, p1, _p2, p3) => p1 + '\n' + safe + '\n' + p3)
  return tpl.replace('</body>', () => `<script id="report-data" type="application/json">\n${safe}\n</script>\n</body>`)
}

// Define window.__aiEmosLive ANTES del listener del template → activa SSE.
function injectLive(tpl, liveUrl) {
  const tag = `<script>window.__aiEmosLive=${JSON.stringify(liveUrl)};</script>`
  if (tpl.includes('<head>')) return tpl.replace('<head>', () => '<head>\n' + tag)
  return tag + tpl
}

function readTemplate(name) {
  return fs.readFileSync(path.join(ASSETS, name), 'utf8')
}

async function parseTrace(opts) {
  const criteria = opts.criteria || loadCriteria()
  const baselines = opts.baselines || loadBaselines()
  return enrich(await adapters.parse(opts), { criteria, baselines })
}

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}
function sendJson(res, data) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
function notFound(res, msg = 'no encontrado') {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(msg)
}

/**
 * serve(opts) → Promise<{ url, close }>
 * opts: { port=7878, session, dashboard, adapter|source }
 */
export async function serve(opts = {}) {
  const port = opts.port || 7878
  const adapter = opts.adapter || opts.source || null
  const criteria = loadCriteria()
  const watcher = await pickWatcher()

  const baseOpts = { adapter, source: adapter, criteria }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`)
      const p = url.pathname
      const session = url.searchParams.get('session') || opts.session
      const src = url.searchParams.get('source') || adapter

      // --- SSE: empuja la traza en cada cambio del archivo de la sesión ---
      if (p === '/events') {
        if (!session) return notFound(res, 'falta ?session')
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(': ok\n\n')
        const send = (trace, info) => {
          // JSON.stringify no produce saltos de línea literales (los \n internos
          // van escapados), así que es seguro como un único campo `data:`.
          res.write('data: ' + JSON.stringify(trace) + '\n\n')
          // evento aparte para los tramos a revisar que aparecieron en vivo:
          // alimenta el feed del template sin re-renderizar toda la traza.
          const nf = (info && info.newFindings) || []
          if (nf.length) {
            const payload = { findings: nf, total: ((trace.summary && trace.summary.findings) || []).length }
            res.write('event: finding\ndata: ' + JSON.stringify(payload) + '\n\n')
          }
        }
        const close = await watchSession({ ...baseOpts, session, source: src }, send, { watcher })
        req.on('close', () => close())
        return
      }

      // --- API JSON ---
      if (p === '/api/session') {
        if (!session) return notFound(res, 'falta ?session')
        return sendJson(res, await parseTrace({ ...baseOpts, session, source: src }))
      }
      if (p === '/api/dashboard') {
        const rows = await adapters.listSessions({ ...baseOpts })
        const traces = []
        for (const r of rows) {
          try {
            traces.push(await parseTrace({ ...baseOpts, session: r.file || r.sessionId }))
          } catch {
            /* salta ilegibles */
          }
        }
        return sendJson(res, aggregate(traces))
      }

      // --- Dashboard (estático; sin SSE en v1) ---
      if (p === '/dashboard') {
        const rows = await adapters.listSessions({ ...baseOpts })
        const traces = []
        for (const r of rows) {
          try {
            traces.push(await parseTrace({ ...baseOpts, session: r.file || r.sessionId }))
          } catch {
            /* salta ilegibles */
          }
        }
        return sendHtml(res, injectData(readTemplate('dashboard.html'), JSON.stringify(aggregate(traces))))
      }

      // --- Timeline en vivo (raíz o /timeline) ---
      if (p === '/' || p === '/timeline') {
        if (!session) {
          // sin sesión fija: manda al dashboard
          res.writeHead(302, { location: '/dashboard' })
          return res.end()
        }
        const trace = await parseTrace({ ...baseOpts, session, source: src })
        const liveUrl = '/events?session=' + encodeURIComponent(session) + (src ? '&source=' + encodeURIComponent(src) : '')
        const tpl = injectLive(readTemplate('timeline.html'), liveUrl)
        return sendHtml(res, injectData(tpl, JSON.stringify(trace)))
      }

      notFound(res)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('error: ' + (e && e.message ? e.message : String(e)))
    }
  })

  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  const route = opts.dashboard || !opts.session ? '/dashboard' : '/timeline?session=' + encodeURIComponent(opts.session)
  const url = `http://127.0.0.1:${port}${route}`
  return { url, close: () => server.close() }
}

export default { serve }
