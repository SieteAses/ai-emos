# Esquema Canónico de Traza (agnóstico al modelo/sistema)

Este es el **contrato** que hace a `ai-emos` agnóstico. Cada adaptador
(`core/adapters/*.mjs`) convierte el formato nativo de su fuente — transcripts de
Claude Code, spans OpenTelemetry-GenAI, eventos NDJSON, historiales de Cursor o
Codex — a **esta** forma. El visualizador (HTML) y `core/render.mjs` consumen
**solo** esto, así que sumar un sistema nuevo = escribir un adaptador, sin tocar
la UI ni el núcleo.

El diseño está alineado con las convenciones de
[OpenTelemetry GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/) y
[OpenInference](https://github.com/Arize-ai/openinference) (spans `llm`, `tool`,
`agent`, atributos de tokens), con un mínimo propio para lo que esas specs aún no
cubren bien: decisiones *human-in-the-loop*, anidación de sub-agentes y marcado de
"tramos flojos".

## `Trace`

```jsonc
{
  "schemaVersion": 1,
  "source": "claude-code",        // qué adaptador la produjo
  "sessionId": "f73ee7f0-…",
  "title": "Avanza con BE-013",    // título legible (puede ser null)
  "cwd": "/Users/…/cachemos",      // contexto, opcional
  "startedAt": "2026-06-27T22:25:37.698Z",
  "endedAt":   "2026-06-28T20:39:52.000Z",
  "models": ["claude-opus-4-8"],   // modelos vistos en la sesión
  "tokens": { … },                 // agregado de toda la sesión (ver Tokens)
  "steps": [ Step, … ],            // pasos en orden cronológico
  "summary": { … }                 // lo agrega core/render.mjs (no los adaptadores)
}
```

## `Step`

Un paso es una unidad atómica del flujo. Campos comunes:

```jsonc
{
  "index": 0,                      // orden estable dentro de su lista
  "timestamp": "2026-…Z",          // ISO 8601 o null
  "kind": "tool_call",             // ver Tipos de paso
  "label": "tool:Bash",            // etiqueta corta para la UI
  "role": "assistant",             // user | assistant | system | tool | null
  "text": "…",                     // texto del paso (mensajes/thinking), o null
  "io": {                          // I/O de la llamada (tools/agents/skills)
    "input":  "…",                 // string o JSON serializable
    "output": "…",
    "isError": false,
    "truncated": false             // true si input/output fue recortado
  },
  "tokens": Tokens | null,         // ver Tokens (atribuido por turno/sub-agente)
  "durationMs": 798778,            // si la fuente lo reporta
  "agent": Agent | null,           // solo kind=agent: sub-pasos anidados
  "decision": Decision | null,     // solo kind=decision: HITL
  "flags": ["retry", "slow"],      // heurísticas de "tramo flojo" (las pone render)
  "raw": { "ref": "…" }            // puntero opcional al dato nativo (debug)
}
```

### Tipos de paso (`kind`)

| kind         | qué representa                                              |
|--------------|------------------------------------------------------------|
| `message`    | mensaje de usuario o asistente (texto)                     |
| `thinking`   | razonamiento extendido del modelo                          |
| `llm_call`   | una llamada al LLM como tal (cuando la fuente la expone)    |
| `tool_call`  | uso de una herramienta (Bash, Read, Edit, MCP, …)          |
| `agent`      | invocación de un sub-agente (lleva `agent.steps[]` anidados)|
| `skill`      | invocación de una skill / workflow                         |
| `decision`   | punto *human-in-the-loop* (pregunta, plan, permiso)        |
| `event`      | evento de sesión (inicio/fin, marca de fase, interrupción) |

### `Tokens`

Normalizado. **Todos los campos son opcionales** — muchas fuentes no reportan
caché, y algunas no reportan tokens en absoluto (entonces `tokens` es `null` y la
UI muestra "n/d"). La granularidad real suele ser **por turno del LLM** o **por
sub-agente** (no por tool individual), y la UI lo explicita.

```jsonc
{
  "input": 7931,        // tokens de entrada no cacheados
  "output": 302,
  "cacheRead": 15853,   // leídos de caché de prompt (si aplica)
  "cacheCreate": 2745,  // que crearon caché (si aplica)
  "total": 26831        // suma; si falta, render la calcula
}
```

### `Agent` (solo `kind: "agent"`)

```jsonc
{
  "name": "backend",          // tipo/nombre del sub-agente
  "id": "a4eb2a9ab0cb0c880",  // id de la corrida del sub-agente
  "model": "claude-opus-4-8[1m]",
  "durationMs": 798778,
  "stats": {                  // libre por fuente; ej. Claude Code toolStats
    "readCount": 21, "bashCount": 36, "editFileCount": 24,
    "linesAdded": 583, "linesRemoved": 201, "toolUseCount": 81
  },
  "steps": [ Step, … ]        // timeline interno del sub-agente (recursivo)
}
```

### `Decision` (solo `kind: "decision"`)

```jsonc
{
  "kind": "question",         // question | plan | permission
  "prompt": "¿Cómo lo resolvemos?",
  "options": [                // opciones ofrecidas (si las hubo)
    { "label": "Opción A", "description": "…" }
  ],
  "chosen": ["Opción A"],     // qué eligió el humano (array por multiSelect)
  "decidedBy": "human",       // human | auto
  "interrupted": false        // true si el humano interrumpió el turno
}
```

## `summary` (lo agrega `core/render.mjs`, no los adaptadores)

```jsonc
{
  "stepCounts": { "tool_call": 42, "agent": 5, "decision": 3, … },
  "tokens": Tokens,                 // = Trace.tokens, por conveniencia
  "agents": [ { "name", "id", "tokens", "durationMs", "flags" }, … ],
  "skills": [ { "name", "count" }, … ],
  "decisions": [ { "index", "prompt", "chosen" }, … ],
  "weakSpots": [ { "index", "flags", "why" }, … ],  // tramos "flojos"
  "models": ["…"]
}
```

## Reglas para autores de adaptadores

1. **No inventes campos fuera de este esquema.** Si tu fuente trae algo único,
   mételo en `step.raw` o `agent.stats`.
2. **Orden cronológico** de `steps` por `timestamp`; si no hay timestamp, conserva
   el orden de aparición.
3. **Tokens honestos:** repórtalos en el nivel que la fuente realmente atribuye
   (turno o sub-agente). No los inventes por-tool. Si no hay, deja `null`.
4. **Degradación con gracia:** cualquier campo desconocido va `null`; la UI no
   asume que exista.
5. **No calcules `flags` ni `summary`** — eso es trabajo de `core/render.mjs`,
   para que todas las fuentes reciban el mismo análisis.
