#!/usr/bin/env bash
# Create a ready-made dsh-pi profile from the shipped template.
#
# Usage:
#   setup-profile.sh <name> [web|headless] [--local]
#
#   name      profile id (e.g. `pi`) → boots with `dsh --profile <name>`
#   web|headless  profile kind (default: web)
#   --local   point dependencies at this repo's packages/ (pre-publish);
#             default is the npm registry versions (@dsh-pi/* on npm)
set -euo pipefail

NAME="${1:?usage: setup-profile.sh <name> [web|headless] [--local]}"
KIND="${2:-web}"
MODE="${3:-registry}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${DSH_HOME:-$HOME/.dsh}/profiles/$NAME"
SRC="$REPO_ROOT/profile/$KIND"

[ -d "$SRC" ] || { echo "unknown kind '$KIND' (web|headless)"; exit 1; }
[ -d "$DEST" ] && { echo "profile '$NAME' already exists at $DEST"; exit 1; }

mkdir -p "$DEST"
cp "$SRC/package.json" "$SRC/pnpm-workspace.yaml" "$DEST/"
[ -f "$SRC/cordis.patch.yml" ] && cp "$SRC/cordis.patch.yml" "$DEST/"

if [ "$MODE" = "--local" ]; then
  node -e "
    const fs = require('fs')
    const f = '$DEST/package.json'
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    for (const k of Object.keys(j.dependencies)) {
      if (k.startsWith('@dsh-pi/')) j.dependencies[k] = 'file:$REPO_ROOT/packages/' + k.slice('@dsh-pi/'.length)
    }
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n')
  "
  echo "(local mode: dependencies point at $REPO_ROOT/packages)"
fi

(cd "$DEST" && pnpm install)

echo "✅ profile '$NAME' ready — boot with: dsh --profile $NAME"
