# ai-emos

Observabilidad de **flujos de trabajo con IA**, agnóstica al modelo/sistema.

Tienes observabilidad de tu *producto*; esto te da observabilidad de **cómo trabajó
la IA**. A partir del historial de una sesión reconstruye un catastro interactivo:
qué agentes, sub-agentes, skills y herramientas se tocaron, su I/O, los puntos
*human-in-the-loop* (dónde decidiste tú), los tokens por turno, y los **tramos a
revisar** para iterar tu desarrollo con criterio.

## Por qué es agnóstico

El corazón no es un parser de Claude: es un **esquema canónico de traza**
([core/trace-schema.md](core/trace-schema.md), alineado a OpenTelemetry-GenAI /
OpenInference) + **adaptadores por fuente**. El visor (HTML) consume solo la traza
canónica, así que sumar un sistema = un adaptador, sin tocar la UI.

Fuentes soportadas (`core/adapters/`):

| fuente | adaptador | cómo |
|---|---|---|
| **Claude Code** | `claude-code` | transcripts automáticos en `~/.claude/projects` |
| **agentes propios** | `ndjson` | mini-SDK `sdk/emit.{mjs,py}` → archivo NDJSON |
| **OpenTelemetry-GenAI / OpenInference** | `otel-genai` | export OTLP-JSON (vía universal) |
| **OpenAI / Codex CLI** | `openai-codex` | rollouts JSONL en `~/.codex/sessions` |
| **Cursor** | `cursor` | export JSON del chat |

¿Otra fuente? Copia [`core/adapters/_template.mjs`](core/adapters/_template.mjs).

## Eficiencia en tokens

El trabajo pesado lo hace un script Node (transcript → JSON); un `template.html`
estático aporta la interactividad; el modelo solo corre el script. **El historial
nunca entra al contexto del modelo** ⇒ el costo en tokens de generar el visor es
~constante, sin importar el tamaño de la sesión.

## Uso (sin Claude Code, autónomo)

```sh
# listar sesiones de Claude Code
node skills/visualize-session/scripts/cli.mjs --list --since 7d

# timeline de una sesión → HTML self-contained
node skills/visualize-session/scripts/cli.mjs --session <id> --html ./timeline.html

# dashboard cross-sesión
node skills/visualize-session/scripts/cli.mjs --dashboard --since 7d --html ./dashboard.html

# otras fuentes (autodetecta por extensión, o usa --adapter)
node skills/visualize-session/scripts/cli.mjs --session ./run.ndjson --html out.html
node skills/visualize-session/scripts/cli.mjs --adapter otel-genai --session ./spans.json --html out.html
```

## Dos superficies, un solo núcleo

ai-emos es un **monorepo**: `core/` (esquema + adaptadores + render + judge), `sdk/`
y los templates HTML son la base compartida. Encima hay dos frontends finos —
independientes entre sí:

| Tienes… | Puedes… | ¿Necesitas lo otro? |
|---|---|---|
| **Solo la extensión de VS Code** | TODO lo visual/interactivo: listar, visualizar, agregados, guardar HTML, abrir archivos de otras fuentes | **No** necesitas el plugin |
| **Solo el plugin (skills)** | Que un agente/chat genere el HTML standalone (portable: terminal, Cursor, CI) | **No** necesitas la extensión |
| **Ambos** | El agente, dentro de VS Code, abre el **panel nativo** de la extensión (handoff vía `vscode://`) | — |

La extensión vive en [`vscode-extension/`](vscode-extension/README.md) y al
empaquetar (`vsce package`) se vuelve **self-contained** (incluye `core/` + assets),
así que el `.vsix` funciona sin el repo ni el plugin.

## Instalación

**Extensión de VS Code** (también Cursor / VSCodium vía Open VSX):

```sh
# desde VS Code: busca "ai-emos" en la pestaña de Extensiones, o
code --install-extension SieteAses.ai-emos
```

**Plugin de Claude Code** (marketplace Git):

```
/plugin marketplace add SieteAses/ai-emos
/plugin install ai-emos@ai-emos
```

Para desarrollo local del plugin sin marketplace: `bash setup.sh` (enlaza las skills
en `~/.claude/skills`).

## Uso (como plugin de Claude Code)

Las skills se invocan en lenguaje natural: *"visualiza esta sesión"*, *"dashboard de
mis sesiones"*, *"haz observable a mi agente"*. Ver
[`skills/visualize-session`](skills/visualize-session/SKILL.md) e
[`instrument-source`](skills/instrument-source/SKILL.md).

Dentro de VS Code, `cli.mjs --session <id> --open auto` hace **handoff** a la
extensión (panel nativo); fuera, genera el HTML standalone.

## "Tramos a revisar"

Cada hallazgo se etiqueta con `category` + `severity`:

- **eficiencia** — caché fría, sub-agente caro (≥ p90 de tokens).
- **fricción** — errores de tool, reintentos, interrupciones.
- **latencia** — sub-agente lento (≥ p90 de duración).
- **calidad** — respuesta/razonamiento flojo. Lo detecta un paso **opcional** de
  LLM-judge ([core/judge.mjs](core/judge.mjs)), **backend-agnóstico**:
  - `harness` (recomendado): usa **el modelo del chat** que llamó la skill
    (sub-agentes) — cero key, cero costo extra, ideal si pagas suscripción.
  - `local`: modelo local OpenAI-compatible (Ollama/LM Studio) — sin key, sin costo.
  - `api`: solo si tienes key (Anthropic u OpenAI-compatible).

  Las tres primeras categorías son **mecánicas** (cero LLM, cero tokens).

## Honestidad de tokens

La granularidad real es por turno de LLM y por sub-agente, **no por herramienta**.
El visor lo refleja; las fuentes que no reportan tokens muestran "n/d".

## Layout

```
core/                    # AGNÓSTICO
  trace-schema.{md,json} # esquema canónico (contrato)
  render.mjs             # traza → datos para el HTML + findings mecánicos
  judge.mjs              # LLM-judge opcional, backend-agnóstico
  adapters/              # un adaptador por fuente (detect/parse/listSessions)
sdk/emit.{mjs,py}        # mini-SDK NDJSON para agentes propios
skills/
  visualize-session/     # genera el HTML (timeline / dashboard)
  instrument-source/     # verifica captura / hooks / SDK / OTel
docs/transcript-schema.md# formato nativo de Claude Code (referencia)
```

## Complementario a `session-report`

La skill oficial `session-report` da **analítica agregada de costo** (tokens por
proyecto/skill/subagente) solo de Claude Code. `ai-emos` se enfoca en el
**flujo de una sesión** y los **puntos de decisión**, y es **multi-fuente**.
