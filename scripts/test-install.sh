#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

HOME_DIR="$TMP/home"
DIST="$TMP/dist"
mkdir -p "$HOME_DIR" "$DIST"
printf '#!/bin/sh\nexit 0\n' > "$DIST/splus-engine"
printf '#!/usr/bin/env node\n' > "$DIST/mcp.cjs"
chmod +x "$DIST/splus-engine"

fresh=$(
  HOME="$HOME_DIR" \
  SPLUS_LOCAL_DIST="$DIST" \
  SPLUS_NO_ADAPTERS=1 \
  SPLUS_NO_MODIFY_PATH=1 \
  SPLUS_NO_WIRE=1 \
  sh "$ROOT/install.sh"
)
printf '%s\n' "$fresh" | grep -q "Splus is installed."
printf '%s\n' "$fresh" | grep -q "then, in your agent:"
printf '%s\n' "$fresh" | grep -q "update:.*splus update"

updated=$(
  HOME="$HOME_DIR" \
  SPLUS_LOCAL_DIST="$DIST" \
  SPLUS_NO_ADAPTERS=1 \
  SPLUS_NO_MODIFY_PATH=1 \
  sh "$ROOT/install.sh"
)
printf '%s\n' "$updated" | grep -q "core updated"
printf '%s\n' "$updated" | grep -q "Splus is up to date."
if printf '%s\n' "$updated" | grep -q "wiring coding agents"; then
  echo "update unexpectedly rewired coding agents" >&2
  exit 1
fi
if printf '%s\n' "$updated" | grep -q "then, in your agent:"; then
  echo "update unexpectedly printed first-install onboarding" >&2
  exit 1
fi

[ "$("$HOME_DIR/.splus/bin/splus" version)" = "local" ]
grep -q "SPLUS_UPDATE=1" "$HOME_DIR/.splus/bin/splus"
grep -q "SPLUS_INSTALL_DIR=" "$HOME_DIR/.splus/bin/splus"
if grep -q '| sh' "$HOME_DIR/.splus/bin/splus"; then
  echo "update wrapper unexpectedly streams remote code into a shell" >&2
  exit 1
fi

echo "installer smoke tests passed"
