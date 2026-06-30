# Contribuir a ai-emos

¡Gracias por tu interés! `ai-emos` es un proyecto joven y la mejor forma de ayudar
es **validar adaptadores**, **sumar fuentes nuevas** o **pulir la UI/criterios**. Es
MIT, así que el uso comercial y los forks están permitidos.

## Cómo correr en local

- **Plugin de Claude Code (skills):**
  ```sh
  bash setup.sh   # enlaza las skills en ~/.claude/skills (idempotente)
  ```
- **Extensión de VS Code:** abre `vscode-extension/` en VS Code y pulsa `F5`
  (Extension Development Host). No hay paso de build: es JS plano y carga `core/`
  (ESM) con `import()` dinámico.
- **CLI autónomo (sin nada instalado):**
  ```sh
  node skills/visualize-session/scripts/cli.mjs --list --since 7d
  node skills/visualize-session/scripts/cli.mjs --session <id|ruta> --html out.html
  ```

## Añadir una fuente (un adaptador)

El núcleo es agnóstico: el visor y `core/render.mjs` consumen **solo** la Traza
Canónica ([core/trace-schema.md](core/trace-schema.md)). Sumar un sistema = escribir
un adaptador, sin tocar la UI.

1. Copia [`core/adapters/_template.mjs`](core/adapters/_template.mjs) a
   `core/adapters/<fuente>.mjs`.
2. Implementa el contrato: `detect(opts)`, `async parse(opts)` y (opcional)
   `async listSessions(opts)`.
3. Mapea el formato nativo a la Traza Canónica respetando las **reglas para autores**
   del esquema:
   - No inventes campos fuera del esquema; lo raro va en `step.raw` o `agent.stats`.
   - `steps` en orden cronológico (por `timestamp`; si no hay, conserva el de aparición).
   - **Tokens honestos** al nivel que la fuente realmente atribuye (turno/sub-agente);
     si no hay, deja `null` (la UI muestra "n/d"). No los inventes por herramienta.
   - Degrada con gracia: lo desconocido va `null`.
   - No calcules `flags` ni `summary` — eso es trabajo de `core/render.mjs`.
4. Regístralo en [`core/adapters/index.mjs`](core/adapters/index.mjs) (import + en
   `ADAPTERS`; añade un alias en `pick()` si conviene).
5. Verifícalo con el CLI:
   ```sh
   node skills/visualize-session/scripts/cli.mjs --adapter <fuente> --session <ruta> --html out.html
   ```

Buen ejemplo de referencia "best-effort": `core/adapters/openai-codex.mjs` y
`core/adapters/vscode-chat.mjs`.

## Validar un adaptador marcado 🧪

El README distingue fuentes **✅ validadas** de **🧪 implementadas pero sin validar
end-to-end**. Si pruebas una marcada 🧪 contra datos reales:

1. Genera/exporta una sesión real de esa fuente.
2. Córrela por el CLI y revisa el timeline (pasos, tokens, decisiones).
3. Abre un Issue contando qué versión/fuente probaste y qué encajó o no (idealmente
   con un fragmento del formato nativo, anonimizado). Eso nos deja moverla a ✅.

## Estilo y PRs

- `core/` y `sdk/` son **ESM** (`.mjs`); la extensión es **CommonJS**. Sin
  TypeScript ni paso de build.
- Mantén el patrón de **mínimo costo de tokens**: el trabajo pesado lo hace el
  script; el historial **nunca** entra al contexto del modelo.
- Abre PRs contra `main`. Describe qué fuente/UI tocaste y cómo lo probaste.
- Licencia: MIT.

¿Dudas o ideas? Abre un Issue: https://github.com/SieteAses/ai-emos/issues
