---
name: visualize-session
description: >-
  Genera un documento HTML interactivo que reconstruye CÓMO trabajó la IA en una
  sesión: línea de tiempo de cada agente, sub-agente, skill y herramienta, con su
  I/O, los puntos human-in-the-loop (qué decidió el usuario), los tokens por turno
  y los "tramos a revisar". Úsala cuando el usuario pida "visualiza esta sesión",
  "muéstrame el flujo de la conversación", "catastro de cómo trabajó la IA", "qué
  agentes/skills se tocaron", "timeline de la sesión", "observabilidad de este
  trabajo con IA", o "dashboard de mis sesiones". Funciona con Claude Code
  (transcripts automáticos), agentes propios (NDJSON via SDK), OpenTelemetry-GenAI,
  Cursor y OpenAI/Codex — es agnóstica al modelo/sistema. El trabajo pesado lo hace
  un script (el historial NUNCA entra al contexto del modelo): tu costo en tokens
  es ~constante sin importar el tamaño de la sesión.
version: 0.1.0
---

# visualize-session

Convierte una sesión de trabajo con IA en un **HTML interactivo** (timeline) o un
**dashboard cross-sesión**. Patrón de mínimo costo de tokens: un script Node parsea
el historial → JSON; un `template.html` estático aporta toda la interactividad; tú
solo corres el script. **No leas el transcript a tu contexto** — deja que el script
lo haga.

`<skill-dir>` = el directorio de este SKILL.md. El CLI está en
`<skill-dir>/scripts/cli.mjs` y resuelve solo el resto del repo.

## Timeline de UNA sesión

1. **Elige la sesión.** Si el usuario no la nombró, lístalas y pregúntale cuál:
   ```sh
   node <skill-dir>/scripts/cli.mjs --list --since 7d
   ```
   (`--adapter` opcional: `claude-code` por defecto; `ndjson`, `otel-genai`,
   `cursor`, `openai-codex` para otras fuentes — o deja que autodetecte por la ruta.)

2. **Abre el timeline.** Usa `--open auto` (recomendado): si la sesión corre
   **dentro de VS Code** y la extensión ai-emos está instalada, hace *handoff* y
   abre el **panel nativo**; si no, genera el **HTML standalone** y reporta la ruta.
   ```sh
   node <skill-dir>/scripts/cli.mjs --session <id|ruta> --open auto
   ```
   - Forzar archivo HTML (portable, cualquier entorno): `--html ./session-timeline-<id>.html`.
   - Forzar panel de VS Code: `--open vscode` (requiere la extensión).
   - Para fuentes no-Claude pasa la **ruta** como `--session` (p.ej.
     `--session ./run.ndjson`, `--session ./spans.otlp.json`, `--session ./chat.json`);
     autodetecta el adaptador por la extensión.

3. **Reporta el resultado:** si abrió en VS Code, dilo; si generó HTML, reporta la
   ruta. No abras el HTML tú.

> El handoff usa el deep link `vscode://ai-emos.ai-emos/timeline?session=<id>` (o
> `?file=<ruta>`), que la extensión atiende y renderiza con el mismo `core/`. Ver
> `--open vscode --dry-run` para inspeccionar el enlace sin lanzarlo.

## Dashboard cross-sesión

```sh
node <skill-dir>/scripts/cli.mjs --dashboard --since 7d --html ./av-dashboard.html
```

## Detección de "tramos a revisar" de calidad (opcional, LLM-judge)

Las señales mecánicas (errores, reintentos, sub-agente caro/lento, caché fría) se
calculan **siempre, sin LLM**. Para detectar problemas de **calidad** (respuestas
flojas, razonamiento incompleto) hay un paso opcional, **backend-agnóstico**:

- **`--judge harness` (recomendado, suscripción):** el script NO llama a ninguna
  API. Corre el CLI con `--judge harness --json` para obtener `judgeCandidates`,
  y **TÚ (este chat, con el modelo del usuario) evalúa cada candidato** — idealmente
  lanzando sub-agentes en paralelo (uno por lote) que devuelvan, por candidato:
  `{index, real, severity: alta|media|baja, why, recommendation}`. Cero key, cero
  costo de API extra: usa la suscripción que ya corre esta skill.
  Luego inyecta esos veredictos como findings de categoría `calidad` en el HTML
  (añádelos al array `summary.findings` del JSON antes de escribir el template, o
  pídele al usuario que prefiera el modo simple sin judge).
- **`--judge local`** (modelo local, sin key, sin costo):
  ```sh
  node <skill-dir>/scripts/cli.mjs --session <id> \
    --judge local --judge-endpoint http://localhost:11434/v1 --judge-model qwen2.5 \
    --html ./session-timeline-<id>.html
  ```
- **`--judge api`** (solo si el usuario tiene key de pago):
  `--judge api --judge-format anthropic --judge-model claude-haiku-4-5 --judge-key-env ANTHROPIC_API_KEY`
  (o `--judge-format openai` con `--judge-endpoint`). Haiku 4.5 es el modelo
  Anthropic más barato capaz para juzgar.

Si el usuario no menciona calidad, NO actives el judge: el análisis mecánico ya es
útil y es gratis.

## Notas

- **Honestidad de tokens:** la granularidad real es por turno de LLM y por
  sub-agente, no por herramienta individual (el log no atribuye coste por tool).
  El resumen incluye un **desglose por turno** (`summary.turns`): coste de cada
  turno y qué herramientas corrió dentro, con la suma exacta = total de la sesión.
  No prometas costo por-tool: muestra el del turno y qué pasó en él.
- **Skills ejecutadas por Bash:** si una skill se invoca corriendo su script
  (`node skills/<n>/scripts/cli.mjs`) en vez del tool `Skill`, igual se cuenta:
  el adaptador la detecta por la ruta del comando (`summary.skills[].via` indica
  `skill-tool` / `command` / `bash`).
- El template (`assets/timeline.html` / `assets/dashboard.html`) es la fuente de la
  interactividad (colapsar, anidar sub-agentes, filtrar por tipo, saltar a los
  tramos a revisar). Tu trabajo es correr el script y reportar la ruta.
- Para capturar trabajo de Claude Code no hay que instrumentar nada (los
  transcripts ya lo graban). Para agentes propios u otras fuentes, ver la skill
  `instrument-source`.
