#!/usr/bin/env bash
# setup.sh — instala ai-emos como plugin local de Claude Code,
# enlazando sus skills en ~/.claude/skills (idempotente).
#
# Alternativa al plugin: si usas el plugin (.claude-plugin/plugin.json) vía un
# marketplace, no necesitas esto. Este script es para uso local rápido.

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
DEST="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"

mkdir -p "$DEST"
for skill in visualize-session instrument-source; do
  link="$DEST/$skill"
  target="$REPO/skills/$skill"
  if [ -L "$link" ] || [ -e "$link" ]; then
    rm -rf "$link"
  fi
  ln -s "$target" "$link"
  echo "enlazada skill: $link -> $target"
done

echo ""
echo "Listo. Verifica la captura de Claude Code con:"
echo "  node \"$REPO/skills/instrument-source/scripts/install-hooks.mjs\" --check"
echo ""
echo "Genera un timeline con:"
echo "  node \"$REPO/skills/visualize-session/scripts/cli.mjs\" --list --since 7d"
