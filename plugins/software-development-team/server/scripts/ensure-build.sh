#!/bin/sh
# Ensures the MCP server's dependencies are installed and the TypeScript sources
# are compiled, then prints the absolute path to the built entry point on stdout.
#
# ALL diagnostics go to stderr; stdout carries ONLY the entry path so callers can
# capture it with `ENTRY=$(ensure-build.sh ...)`.
#
# Usage: ensure-build.sh <SRC_DIR> [BUILD_DATA_DIR]
#   SRC_DIR          read-only plugin server dir (contains src/, package.json, …)
#   BUILD_DATA_DIR   writable persistent dir to build into (CLAUDE_PLUGIN_DATA).
#                    Omitted/empty or equal to SRC_DIR => build in place (local dev).
#
# CLAUDE_PLUGIN_ROOT is read-only and is reset on plugin update, so when a writable
# data dir is provided we build there instead and keep it warm across updates.
set -eu

SRC_DIR="${1:?source dir required}"
DATA_DIR="${2:-${CLAUDE_PLUGIN_DATA:-}}"

# Ignore an un-interpolated data-dir arg (literal "${CLAUDE_PLUGIN_DATA}") so we
# never create a bogus directory; fall back to the env var, then to in-place.
case "$DATA_DIR" in *'${'*) DATA_DIR="${CLAUDE_PLUGIN_DATA:-}" ;; esac
case "$DATA_DIR" in *'${'*) DATA_DIR="" ;; esac

log() { printf '[software-development-team] %s\n' "$1" >&2; }

# Decide where to build: out-of-tree into the writable data dir when available,
# otherwise in place (local development against the source checkout).
if [ -n "$DATA_DIR" ] && [ "$DATA_DIR" != "$SRC_DIR" ]; then
  BUILD_DIR="$DATA_DIR/server"
  OUT_OF_TREE=1
else
  BUILD_DIR="$SRC_DIR"
  OUT_OF_TREE=0
fi
ENTRY="$BUILD_DIR/dist/index.js"

mkdir -p "$BUILD_DIR"

# Order-independent, content-sensitive signature of all build inputs.
build_signature() {
  {
    find "$SRC_DIR/src" -type f -exec cksum {} + 2>/dev/null | awk '{print $1, $3}'
    cksum "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" \
          "$SRC_DIR/tsconfig.json" "$SRC_DIR/tsup.config.ts" 2>/dev/null | awk '{print $1, $3}'
  } | sort | cksum | awk '{print $1 "-" $2}'
}
WANT="$(build_signature)"
STAMP="$BUILD_DIR/.build-stamp"

if [ -f "$ENTRY" ] && [ -d "$BUILD_DIR/node_modules" ] \
   && [ "$(cat "$STAMP" 2>/dev/null || true)" = "$WANT" ]; then
  log "server already built and up to date"
  printf '%s\n' "$ENTRY"
  exit 0
fi

log "building MCP server in $BUILD_DIR (first run or sources changed)…"

if [ "$OUT_OF_TREE" -eq 1 ]; then
  # Sync sources into the writable build dir (node_modules/dist stay local to it).
  rm -rf "$BUILD_DIR/src"
  cp -R "$SRC_DIR/src" "$BUILD_DIR/src"
  for f in package.json package-lock.json tsconfig.json tsup.config.ts vitest.config.ts; do
    [ -f "$SRC_DIR/$f" ] && cp "$SRC_DIR/$f" "$BUILD_DIR/$f"
  done
fi

cd "$BUILD_DIR"

# Install dependencies only when the manifest changed (devDeps are needed to build).
NPM_STAMP="$BUILD_DIR/.npm-stamp"
NPM_WANT="$(cksum package.json package-lock.json 2>/dev/null | awk '{print $1, $3}' | sort | cksum | awk '{print $1}')"
if [ ! -d node_modules ] || [ "$(cat "$NPM_STAMP" 2>/dev/null || true)" != "$NPM_WANT" ]; then
  log "installing dependencies…"
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund 1>&2
  else
    npm install --no-audit --no-fund 1>&2
  fi
  printf '%s\n' "$NPM_WANT" > "$NPM_STAMP"
fi

log "compiling…"
npm run build 1>&2

printf '%s\n' "$WANT" > "$STAMP"
log "build complete"
printf '%s\n' "$ENTRY"
