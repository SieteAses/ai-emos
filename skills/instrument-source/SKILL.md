---
name: instrument-source
description: >-
  Prepara una fuente de IA para que su trabajo quede observable por
  ai-emos, consultando al usuario en cada paso. Para Claude Code:
  verifica que los transcripts se estén grabando (la captura YA es automática, no
  hay que instrumentar nada) y, opcionalmente, instala hooks ligeros
  (SessionStart/Stop/SubagentStop) para marcar límites y fases en el timeline; y un
  helper opt-in para anotar un agente/skill puntual. Para agentes propios: instala
  el mini-SDK NDJSON. Para sistemas con OpenTelemetry: guía el export OTel-GenAI.
  Úsala cuando el usuario diga "instrumenta mis sesiones", "captura el trabajo de mi
  agente", "haz observable a Cursor/Codex/mi agente", "verifica que se esté grabando
  el historial", o "instala los hooks del visualizador".
version: 0.1.0
---

# instrument-source

La idea central: **no instrumentes para capturar lo que ya se captura.** Antes de
tocar nada, identifica la fuente y aplica el mínimo necesario.

## 1. Claude Code (la captura ya es automática)

Los transcripts JSONL en `~/.claude/projects/<proyecto>/` ya graban cada agente,
sub-agente, skill, herramienta, tokens por turno y decisiones human-in-the-loop.
**No hay que editar tus agentes.** Pasos:

1. **Verifica salud de captura:**
   ```sh
   node <skill-dir>/scripts/install-hooks.mjs --check
   ```
   Reporta si existe el directorio de proyectos, la versión de Claude Code vista y
   la última sesión grabada.

2. **(Opcional) Instala hooks de marcado** para enriquecer el timeline sin tocar
   agentes — marcas claras de inicio/fin de sesión y de sub-agente. Consulta al
   usuario antes; edita `settings.json` con respaldo:
   ```sh
   node <skill-dir>/scripts/install-hooks.mjs --install --settings ~/.claude/settings.json
   ```
   Instala hooks `SessionStart`, `Stop` y `SubagentStop` que solo escriben un
   marcador (no bloquean). Usa `--dry-run` para ver el diff sin aplicar.

3. **(Opcional, "ambos") Anotar un agente/skill puntual.** Si el usuario quiere
   etiquetas de fase más ricas que las que ya infiere el parser, añade a UN archivo
   de agente/skill una instrucción ligera para que emita una etiqueta de fase
   legible. Hazlo **archivo por archivo, consultando al usuario** — nunca masivo, y
   nunca reescribas los 22 agentes de golpe.

## 2. Agentes propios (mini-SDK NDJSON)

Para cualquier agente JS/TS o Python que el usuario controle, instala el SDK y
muéstrale cómo emitir eventos. El adaptador `ndjson` los ingiere tal cual.

- JS/TS: `sdk/emit.mjs` → `import { Tracer } from '<repo>/sdk/emit.mjs'`
- Python: `sdk/emit.py` → `from emit import Tracer`

Ejemplo mínimo (ver cabecera de `sdk/emit.mjs` para la API completa):
```js
const t = new Tracer('./traces/run.ndjson', { title:'mi corrida', source:'mi-agente' })
t.message('user', '...'); const a = t.agent('worker'); a.tool('search', {input,output})
t.decision('¿seguir?', { options:['sí','no'], chosen:['sí'] }); t.close()
```
Luego: `visualize-session --session ./traces/run.ndjson`.

## 3. Sistemas con OpenTelemetry

Si el sistema ya está (o puede estar) instrumentado con OTel-GenAI/OpenInference,
no hace falta SDK propio. Sigue `<skill-dir>/scripts/setup-otel.md`: activa el
export a archivo OTLP-JSON y visualízalo con
`visualize-session --adapter otel-genai --session ./spans.otlp.json`.

## 4. Cursor / OpenAI-Codex

- **Codex CLI:** ya escribe rollouts JSONL en `~/.codex/sessions/`. No instrumentes;
  visualiza con `--adapter openai-codex`.
- **Cursor:** guarda el chat en SQLite. Exporta el chat a JSON y visualiza con
  `--adapter cursor --session ./chat.json`.

## Regla de oro

Instrumentar solo añade lo que la fuente no captura sola. Si dudas, primero
`--check` / intenta visualizar; instrumenta únicamente si falta señal.
