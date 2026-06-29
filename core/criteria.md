# Criterios de "óptimo vs no-óptimo"

Este documento responde, en un solo lugar, la pregunta: **¿qué cuenta como
"demasiados tokens", "muy lento", o "error"?** — y cómo difieren el evaluador
**mecánico** (cero LLM) del evaluador **con IA** (`judge`).

`ai-emos` separa dos planos de evaluación que **no se solapan a propósito**:

| Plano | Quién | Qué juzga | Coste |
|---|---|---|---|
| **Mecánico** | [render.mjs](render.mjs) + [criteria.mjs](criteria.mjs) | costo, latencia, fricción (errores/reintentos/interrupciones) | cero tokens |
| **Con IA** | [judge.mjs](judge.mjs) | **calidad** del trabajo (lo que las señales mecánicas no ven) | opcional |

La regla de oro: **el judge NO mira costo/latencia/errores** — eso ya lo detecta
lo mecánico de forma determinística y gratis. El judge se reserva para lo que
ningún umbral puede ver (razonamiento flojo, respuesta incompleta, supuesto no
verificado, opciones mal planteadas).

---

## 1. Evaluador mecánico — diseño híbrido

Cada paso puede recibir una o más *flags*. Una flag con umbral dispara si se
cumple **cualquiera** de tres condiciones (de ahí "híbrido"):

1. **ABSOLUTO** — supera un presupuesto fijo. Reproducible entre sesiones,
   independiente del resto de la sesión. *"¿Es mucho en términos absolutos?"*
2. **BASELINE** — se desvía más de `sigma`·σ de la media histórica de **ese
   agente o herramienta**, cuando hay ≥ `minSamples` muestras. *"¿Es mucho para
   lo que ESTE agente suele gastar?"*
3. **P90** — está en el percentil 90 **dentro de la sesión actual** (relativo;
   el comportamiento histórico de `render.mjs`). *"¿Es de lo más caro/lento de
   esta sesión en particular?"*

El `finding` resultante anota **qué disparó** en `trigger` (`absoluto` |
`baseline` | `p90`), para que la UI explique el porqué y no solo el qué.

### Flags, categorías y umbrales

| Flag | Categoría | Severidad | Dispara cuando… | Umbral (configurable) |
|---|---|---|---|---|
| `error` | fricción | alta | la herramienta devolvió error | `io.isError === true` (binario) |
| `retry` | fricción | media | se repite el mismo paso tras un error | (binario, sin umbral) |
| `interrupted` | fricción | media | el humano interrumpió el turno | `decision.interrupted` (binario) |
| `slow` | latencia | media | un sub-agente/herramienta tarda demasiado | ABSOLUTO `durationMs.agent`=300 s / `durationMs.tool`=30 s · o BASELINE · o P90 |
| `expensive` | eficiencia | media | un turno/sub-agente gasta demasiados tokens | ABSOLUTO `tokens.agentBudget`=150k / `tokens.turnBudget`=80k · o BASELINE · o P90 |
| `cold-cache` | eficiencia | media | input grande con poca caché (recontextualización) | `tokens.coldCache.minInput`=50k **y** `cacheRead < input·minCacheRatio` (0.5) |

> "Demasiados tokens" = supera `agentBudget`/`turnBudget`, **o** se sale >2σ de
> lo normal para ese agente, **o** es el ≥p90 de la sesión.
> "Muy lento" = la lectura análoga sobre `durationMs`.
> "Error" = `io.isError` — binario, sin matiz: cualquier error es fricción alta.

### Configuración

`loadCriteria()` mezcla, en prioridad creciente:

```
DEFAULTS  ←  ~/.config/ai-emos/criteria.json  ←  .ai-emos.json (cwd)  ←  overrides (VS Code / --criteria)
```

Ejemplo `~/.config/ai-emos/criteria.json` para un equipo que quiere ser más
estricto con la latencia y relajado con tokens:

```json
{
  "durationMs": { "tool": 15000, "agent": 120000 },
  "tokens": { "turnBudget": 120000 },
  "baseline": { "sigma": 1.5 }
}
```

### Línea base por agente

La derivan los agregados cross-sesión (`aggregate` en [render.mjs](render.mjs))
y se **persisten** en `~/.config/ai-emos/baselines.json`: por `agent.name` (y por
`label` de herramienta) se guardan `mean`, `std`, `p90`, `samples` de tokens y
duración. `enrich(trace, { baselines })` los lee si existen. **Sin historia ⇒**
solo aplican ABSOLUTO y P90 (degradación con gracia; nada se rompe la primera vez).

---

## 2. Evaluador con IA (`judge`) — calidad

El judge **no** reimplementa los umbrales de arriba. Recibe segmentos candidatos
(respuestas del asistente, salidas de sub-agentes, puntos de decisión humana) y
emite findings de categoría `calidad` con esta **rúbrica de severidad**:

| Severidad | Significado | Ejemplos |
|---|---|---|
| **alta** | el resultado es incorrecto o engañoso; rehacer | conclusión falsa, supuesto clave no verificado que cambia el resultado, paso crítico saltado |
| **media** | el resultado sirve pero es flojo; conviene iterar | razonamiento incompleto, ambigüedad, no se exploró una alternativa obvia |
| **baja** | matiz menor; mejora opcional | redacción confusa, falta una verificación barata, formato subóptimo |

**Backends** (el CLI elige; ver [judge.mjs](judge.mjs)):

- `harness` (defecto): no llama a ninguna API; expone `judgeCandidates` para que
  la skill los evalúe con el modelo del chat. Cero key, cero costo de API.
- `local`: endpoint OpenAI-compatible local (Ollama, LM Studio, llama.cpp).
- `api`: endpoint con key (Anthropic u OpenAI-compatible).

**Contexto mecánico (opcional):** al judge se le pueden pasar los findings
mecánicos del mismo paso, para que **confirme o descarte** una correlación
calidad↔síntoma ("este sub-agente fue caro y lento — ¿además el trabajo fue
flojo, o simplemente la tarea era grande?"). No cambia su criterio; le da
contexto para no marcar como problema de calidad algo que solo fue costoso.

---

## 3. Cómo difieren, en una frase

- **Mecánico** responde *"¿cuánto costó / cuánto tardó / falló?"* con números y
  reglas — siempre, gratis, reproducible.
- **IA** responde *"¿estuvo bien hecho?"* con juicio — bajo demanda, y solo
  donde los números no alcanzan.

Un paso puede ser barato y rápido pero de baja calidad (solo lo ve el judge), o
caro y lento pero impecable (solo lo ve lo mecánico). Por eso ambos planos
conviven sin pisarse.
