# ai-emos — extensión de VS Code

Abre el **timeline interactivo** de una sesión de trabajo con IA en una ventana de
VS Code (webview), sin generar archivos salvo que pulses **Guardar**. Reutiliza el
núcleo agnóstico y los templates del repo `ai-emos`.

## Comandos (paleta: `Cmd/Ctrl+Shift+P`)

- **ai-emos: Sesiones (lista + agregados)** — vista unificada: lista paginada
  (10/50/100) de tus sesiones de Claude Code con buscador. **Clic en una sesión**
  abre su timeline en una **pestaña nueva**. El botón **📊 Analizar agregados**
  calcula, bajo demanda y sobre las sesiones del filtro, los tokens por
  agente/skill (parsea cada una) — es el antiguo "dashboard", ahora integrado.
- **ai-emos: Visualizar archivo (NDJSON/OTel/Cursor/Codex)** — diálogo para elegir
  un `.ndjson` / OTLP-JSON / export de Cursor / rollout de Codex y ver su timeline.

En los paneles de timeline/dashboard, el botón flotante **💾 Guardar** exporta el
HTML self-contained (elige dónde) — el mismo artefacto portable que genera el CLI.

> El comando antiguo `aiEmos.visualizeSession` sigue existiendo como alias de
> `aiEmos.sessions`.

## Cómo ejecutarla

Esta extensión es **JS plano (CommonJS), sin paso de build**. Carga el núcleo
(`core/`, ESM) con `import()` dinámico desde el host de extensiones, así que solo
necesita VS Code (no requiere `node` en el PATH ni compilar TypeScript).

**Modo desarrollo:**
1. Abre la carpeta `vscode-extension/` en VS Code.
2. Pulsa `F5` (usa `.vscode/launch.json`) → se abre un *Extension Development Host*.
3. Ahí ejecuta cualquier comando `ai-emos: …`.

**Instalar desde un marketplace:**
```sh
# VS Code Marketplace (o busca "ai-emos" en la pestaña Extensiones)
code --install-extension SieteAses.ai-emos
# Cursor / VSCodium: busca "ai-emos" en Extensiones (Open VSX)
```

**Instalar localmente (.vsix) — self-contained:**
```sh
cd vscode-extension
npx @vscode/vsce package      # corre `vscode:prepublish` → node bundle.mjs
code --install-extension ai-emos-0.1.0.vsix
```
`bundle.mjs` copia `core/`, `sdk/` y los `assets` a `vscode-extension/bundled/`, y
`extension.js` usa esa copia si existe (`resolveBase()`); en dev (sin `bundled/`)
lee del repo (`../`). Así el **`.vsix` funciona sin el repo ni el plugin** — con
solo la extensión tienes toda la funcionalidad visual.

## Handoff desde un chat/agente

La extensión registra un `UriHandler`, así que un agente (o el CLI con `--open
auto`) puede abrir un panel con un **deep link**:

```
vscode://ai-emos.ai-emos/timeline?session=<sessionId>   # sesión de Claude Code
vscode://ai-emos.ai-emos/timeline?file=<ruta>            # NDJSON / OTel / Cursor / Codex
vscode://ai-emos.ai-emos/sessions                        # la lista unificada
```

La extensión re-parsea con el mismo `core/` y abre el panel. Inspecciona el enlace
que generaría el CLI con `cli.mjs --session <id> --open vscode --dry-run`.

## Notas

- El webview usa CSP **con nonce** (VS Code no ejecuta inline sin nonce).
- El panel conserva su estado al ocultarse (`retainContextWhenHidden`).
- Complementa al CLI / skills de Claude Code; no los reemplaza.
- La extensión sola **no requiere el plugin**; el plugin solo añade el disparo
  desde una conversación.
