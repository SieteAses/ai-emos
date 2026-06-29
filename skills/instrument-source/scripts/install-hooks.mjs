#!/usr/bin/env node
/**
 * install-hooks.mjs — verifica la captura de Claude Code e instala hooks de
 * marcado OPCIONALES (no bloqueantes) para enriquecer el timeline.
 *
 *   node install-hooks.mjs --check
 *   node install-hooks.mjs --install [--settings <path>] [--dry-run]
 *
 * La captura principal (agentes/skills/tools/tokens/HITL) YA es automática en los
 * transcripts; estos hooks solo escriben marcadores de límite de sesión/sub-agente
 * a un sidecar (~/.claude/av-markers/) por si quieres límites de fase explícitos.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

const argv = process.argv.slice(2)
const has = f => argv.includes(f)
const flag = (n, d) => {
  const i = argv.indexOf(n)
  return i === -1 ? d : argv[i + 1]
}

const PROJECTS = path.join(os.homedir(), '.claude', 'projects')
const MARKERS = path.join(os.homedir(), '.claude', 'av-markers')

function check() {
  const out = { projectsDir: PROJECTS, exists: fs.existsSync(PROJECTS) }
  if (!out.exists) {
    console.log(JSON.stringify({ ...out, ok: false, hint: 'No existe el dir de proyectos de Claude Code.' }, null, 2))
    return
  }
  let latest = null
  let version = null
  let count = 0
  for (const proj of fs.readdirSync(PROJECTS)) {
    const pdir = path.join(PROJECTS, proj)
    let files = []
    try {
      files = fs.readdirSync(pdir).filter(f => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      count++
      const fp = path.join(pdir, f)
      const m = fs.statSync(fp).mtimeMs
      if (!latest || m > latest.m) latest = { m, file: fp, project: proj }
    }
  }
  if (latest) {
    try {
      const first = fs.readFileSync(latest.file, 'utf8').split('\n').find(l => l.trim())
      version = JSON.parse(first).version || null
    } catch {
      /* noop */
    }
  }
  console.log(
    JSON.stringify(
      {
        ...out,
        ok: true,
        sessions: count,
        claudeCodeVersion: version,
        lastSession: latest && { project: latest.project, at: new Date(latest.m).toISOString() },
        note: 'La captura es automática. Hooks de marcado: opcionales (--install).',
      },
      null,
      2,
    ),
  )
}

// comando del hook: añade una línea de marcador al sidecar leyendo el JSON del hook por stdin
function markerCmd(event) {
  // node one-liner portable; lee stdin (Claude Code pasa {session_id,...})
  return (
    `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{` +
    `let s='';try{s=JSON.parse(d).session_id||''}catch(e){};` +
    `const fs=require('fs'),p=require('path'),os=require('os');` +
    `const dir=p.join(os.homedir(),'.claude','av-markers');fs.mkdirSync(dir,{recursive:true});` +
    `fs.appendFileSync(p.join(dir,(s||'session')+'.ndjson'),JSON.stringify({ts:new Date().toISOString(),kind:'event',label:'${event}'})+'\\n')` +
    `})"`
  )
}

const HOOKS = {
  SessionStart: [{ hooks: [{ type: 'command', command: markerCmd('inicio de sesión') }] }],
  Stop: [{ hooks: [{ type: 'command', command: markerCmd('fin de sesión') }] }],
  SubagentStop: [{ hooks: [{ type: 'command', command: markerCmd('fin de sub-agente') }] }],
}

function install() {
  const settingsPath = flag('--settings', path.join(os.homedir(), '.claude', 'settings.json'))
  let settings = {}
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    } catch {
      console.error(`No pude parsear ${settingsPath}; aborto.`)
      process.exit(1)
    }
  }
  const next = JSON.parse(JSON.stringify(settings))
  next.hooks = next.hooks || {}
  for (const [evt, cfg] of Object.entries(HOOKS)) {
    next.hooks[evt] = next.hooks[evt] || []
    const already = JSON.stringify(next.hooks[evt]).includes('av-markers')
    if (!already) next.hooks[evt].push(...cfg)
  }
  const rendered = JSON.stringify(next, null, 2)
  if (has('--dry-run')) {
    console.log('--- settings.json propuesto ---\n' + rendered)
    console.log(`\n(dry-run; sidecar de marcadores: ${MARKERS})`)
    return
  }
  if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, settingsPath + '.bak')
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, rendered)
  console.log(`Hooks instalados en ${settingsPath} (respaldo: ${settingsPath}.bak).`)
  console.log(`Marcadores se escribirán a ${MARKERS}/<session>.ndjson`)
}

if (has('--check') || argv.length === 0) check()
else if (has('--install')) install()
else console.error('Uso: --check | --install [--settings <p>] [--dry-run]')
