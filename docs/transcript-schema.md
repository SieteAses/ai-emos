# Schema nativo de transcripts de Claude Code (referencia)

Notas del formato JSONL que graba Claude Code, descubiertas empíricamente
(`version 2.1.181`). El adaptador `core/adapters/claude-code.mjs` se apoya en esto.
Para el modelo destino agnóstico ver `core/trace-schema.md`.

## Ubicación

```
~/.claude/projects/<proyecto-encoded>/<sessionId>.jsonl          # sesión principal
~/.claude/projects/<proyecto>/<sessionId>/subagents/agent-<agentId>.jsonl
~/.claude/projects/<proyecto>/<sessionId>/subagents/agent-<agentId>.meta.json   # {agentType}
~/.claude/projects/<proyecto>/<sessionId>/workflows/*.jsonl
```

Cada línea es un objeto JSON independiente. Campos top-level comunes:
`type`, `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`, `version`,
`gitBranch`, `isSidechain`, `userType`, `entrypoint`.

## Tipos de línea relevantes

- **`assistant`**: `message.model`, `message.content[]` (bloques `thinking` |
  `text` | `tool_use`), `message.usage` con `input_tokens`, `output_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`. Una respuesta de API se
  parte en varias entradas que comparten `requestId`/`message.id`; **solo la última
  trae el `output_tokens` final** → se deduplica por requestId quedándose con el
  máximo `output_tokens`.

- **`user`**: `message.content` string (prompt humano) o `content[]` con bloques
  `tool_result` (`tool_use_id`, `content`, `is_error`). `toolUseResult` trae datos
  ricos del resultado:
  - Agent/Task → `agentId`, `agentType`, `totalTokens`, `totalDurationMs`,
    `totalToolUseCount`, `usage`, `toolStats` (`readCount`, `bashCount`,
    `editFileCount`, `linesAdded`, `linesRemoved`), `resolvedModel`.
  - AskUserQuestion → `answers` = `{ pregunta: opción_elegida }` (la decisión HITL).

- **`tool_use`** (dentro de assistant): `id`, `name`, `input`.
  - `Agent`/`Task` → sub-agente (`input.subagent_type`, `input.prompt`).
  - `Skill` → `input.skill`.
  - `AskUserQuestion` / `ExitPlanMode` → puntos human-in-the-loop.
  - MCP → nombre `mcp__<server>__<tool>`.

- Atribución de skill: campo `attributionSkill` en mensajes `assistant`; los
  comandos slash aparecen como `<command-name>` en texto de usuario.

- Metadata: `ai-title` (`aiTitle`), `last-prompt`, `file-history-snapshot`,
  `queue-operation` (start/end), `attachment` (deferred tools / agent listing).

## Enlaces

- `tool_use.id` ↔ `tool_result.tool_use_id`.
- Sub-agente: `toolUseResult.agentId` → archivo `subagents/agent-<agentId>.jsonl`,
  parseado recursivamente como timeline anidado.
- Dedupe global por `uuid` (las sesiones reanudadas re-serializan historial).

## Tokens — honestidad

La granularidad real es **por turno de LLM** (`message.usage`) y **total por
sub-agente** (`toolUseResult.totalTokens`). No hay costo de tokens por herramienta
individual. El adaptador atribuye los tokens del turno a un paso del turno y suma
los del árbol (turnos del padre + turnos de cada sub-agente) sin doble-conteo.
