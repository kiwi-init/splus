#!/bin/sh
# Splus installer — open-source, local-first code review for your coding agent.
#
#   curl -fsSL https://splus.sh/install.sh | sh
#
# Downloads the deterministic engine + the local MCP server into ~/.splus and
# wires it into every coding agent it finds (Claude Code, Codex, OpenCode).
# No account, no token, nothing leaves your machine.
#
# Env knobs (all optional):
#   SPLUS_VERSION     pin a release tag (e.g. v0.3.0); default: latest
#   SPLUS_INSTALL_DIR install prefix; default: $HOME/.splus
#   SPLUS_LOCAL_DIST  install from a local dir of built artifacts instead of
#                     downloading (expects splus-engine, cli.cjs, mcp.cjs) —
#                     used for local testing of this script
#   SPLUS_NO_MODIFY_PATH=1  don't touch shell rc files
#   SPLUS_NO_WIRE=1         don't auto-wire coding agents
set -eu

REPO="ojowwalker77/Splus"
INSTALL_DIR="${SPLUS_INSTALL_DIR:-$HOME/.splus}"
BIN_DIR="$INSTALL_DIR/bin"
LIB_DIR="$INSTALL_DIR/lib"
MCP_BIN="$BIN_DIR/splus-mcp"

c_b='\033[1m'; c_dim='\033[2m'; c_grn='\033[32m'; c_red='\033[31m'; c_0='\033[0m'
say()  { printf '%b\n' "${c_dim}splus${c_0} $*"; }
ok()   { printf '%b\n' "  ${c_grn}✓${c_0} $*"; }
warn() { printf '%b\n' "  ${c_red}!${c_0} $*"; }
die()  { printf '%b\n' "${c_red}splus: $*${c_0}" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
command -v git  >/dev/null 2>&1 || die "git is required but not found. Install git and re-run."
command -v node >/dev/null 2>&1 || die "node is required but not found. Install Node.js (>=20) and re-run."

# --- platform detection ----------------------------------------------------
os=$(uname -s); arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) die "unsupported OS '$os'. On Windows, install inside WSL." ;;
esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) die "unsupported architecture '$arch'." ;;
esac
asset="splus-${os}-${arch}.tar.gz"

say "installing for ${c_b}${os}-${arch}${c_0} → ${INSTALL_DIR}"
mkdir -p "$BIN_DIR" "$LIB_DIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --- fetch artifacts -------------------------------------------------------
if [ -n "${SPLUS_LOCAL_DIST:-}" ]; then
  say "using local dist: $SPLUS_LOCAL_DIST"
  cp "$SPLUS_LOCAL_DIST/splus-engine" "$tmp/" || die "missing splus-engine in SPLUS_LOCAL_DIST"
  cp "$SPLUS_LOCAL_DIST/cli.cjs" "$SPLUS_LOCAL_DIST/mcp.cjs" "$tmp/" || die "missing cli.cjs/mcp.cjs in SPLUS_LOCAL_DIST"
  version="local"
else
  if command -v curl >/dev/null 2>&1; then dl() { curl -fsSL "$1" -o "$2"; }
  elif command -v wget >/dev/null 2>&1; then dl() { wget -qO "$2" "$1"; }
  else die "need curl or wget to download."; fi

  ver="${SPLUS_VERSION:-latest}"
  if [ "$ver" = "latest" ]; then base="https://github.com/$REPO/releases/latest/download"
  else base="https://github.com/$REPO/releases/download/$ver"; fi
  version="$ver"

  say "downloading $asset ($ver)"
  dl "$base/$asset" "$tmp/$asset" || die "download failed: $base/$asset (no release for ${os}-${arch}?)"

  # Verify checksum (best-effort: skip cleanly if SHA256SUMS is absent).
  if dl "$base/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
    if command -v sha256sum >/dev/null 2>&1; then sum=$(sha256sum "$tmp/$asset" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then sum=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
    else sum=""; fi
    if [ -n "$sum" ]; then
      want=$(grep " $asset\$" "$tmp/SHA256SUMS" | awk '{print $1}' || true)
      [ -z "$want" ] || [ "$sum" = "$want" ] || die "checksum mismatch for $asset"
      [ -n "$want" ] && ok "checksum verified"
    fi
  fi
  tar -xzf "$tmp/$asset" -C "$tmp" || die "extract failed"
fi

# --- place binaries + wrappers --------------------------------------------
install -m 0755 "$tmp/splus-engine" "$BIN_DIR/splus-engine"
install -m 0644 "$tmp/cli.cjs" "$LIB_DIR/cli.cjs"
install -m 0644 "$tmp/mcp.cjs" "$LIB_DIR/mcp.cjs"

cat > "$BIN_DIR/splus" <<EOF
#!/bin/sh
export SPLUS_ENGINE="\${SPLUS_ENGINE:-$BIN_DIR/splus-engine}"
exec node "$LIB_DIR/cli.cjs" "\$@"
EOF
cat > "$BIN_DIR/splus-mcp" <<EOF
#!/bin/sh
export SPLUS_ENGINE="\${SPLUS_ENGINE:-$BIN_DIR/splus-engine}"
exec node "$LIB_DIR/mcp.cjs" "\$@"
EOF
chmod 0755 "$BIN_DIR/splus" "$BIN_DIR/splus-mcp"
printf '%s\n' "$version" > "$INSTALL_DIR/version"
ok "installed splus, splus-mcp, splus-engine → $BIN_DIR"

# --- PATH ------------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    if [ -z "${SPLUS_NO_MODIFY_PATH:-}" ]; then
      line="export PATH=\"$BIN_DIR:\$PATH\""
      for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
        [ -f "$rc" ] || continue
        grep -qF "$BIN_DIR" "$rc" 2>/dev/null && continue
        printf '\n# Splus\n%s\n' "$line" >> "$rc"
        ok "added $BIN_DIR to PATH in $(basename "$rc")"
      done
      warn "open a new shell (or run: export PATH=\"$BIN_DIR:\$PATH\") to use \`splus\`"
    fi
    ;;
esac

# --- wire coding agents ----------------------------------------------------
wired=0
if [ -z "${SPLUS_NO_WIRE:-}" ]; then
  say "wiring coding agents"

  # Claude Code — use its CLI (idempotent: remove then add).
  if command -v claude >/dev/null 2>&1; then
    claude mcp remove --scope user splus >/dev/null 2>&1 || true
    if claude mcp add --scope user splus -- "$MCP_BIN" >/dev/null 2>&1; then
      ok "Claude Code"; wired=1
    else warn "Claude Code detected but \`claude mcp add\` failed — add manually: claude mcp add --scope user splus -- $MCP_BIN"; fi
  fi

  # Codex — prefer its CLI, else append to ~/.codex/config.toml.
  if command -v codex >/dev/null 2>&1; then
    if codex mcp add splus -- "$MCP_BIN" >/dev/null 2>&1; then ok "Codex"; wired=1
    else warn "Codex detected but \`codex mcp add\` failed — see ~/.codex/config.toml"; fi
  elif [ -d "$HOME/.codex" ]; then
    toml="$HOME/.codex/config.toml"
    if ! grep -q '^\[mcp_servers.splus\]' "$toml" 2>/dev/null; then
      { printf '\n[mcp_servers.splus]\ncommand = "%s"\n' "$MCP_BIN"; } >> "$toml"
    fi
    ok "Codex (~/.codex/config.toml)"; wired=1
  fi

  # OpenCode — merge into opencode.json (node is guaranteed present).
  if command -v opencode >/dev/null 2>&1 || [ -d "$HOME/.config/opencode" ]; then
    ocf="$HOME/.config/opencode/opencode.json"
    mkdir -p "$HOME/.config/opencode"
    if SPLUS_OCF="$ocf" SPLUS_MCPBIN="$MCP_BIN" node <<'EOF'
const fs = require("fs");
const f = process.env.SPLUS_OCF, bin = process.env.SPLUS_MCPBIN;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
cfg["$schema"] = cfg["$schema"] || "https://opencode.ai/config.json";
cfg.mcp = cfg.mcp || {};
cfg.mcp.splus = { type: "local", command: [bin], enabled: true };
fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
EOF
    then ok "OpenCode (~/.config/opencode/opencode.json)"; wired=1
    else warn "OpenCode detected but config merge failed"; fi
  fi

  [ "$wired" = 1 ] || warn "no coding agent detected — register \`$MCP_BIN\` as an MCP server manually"
fi

# --- done ------------------------------------------------------------------
printf '\n%b\n' "${c_grn}${c_b}Splus is installed.${c_0}"
printf '%b\n' "  ${c_dim}then, in your agent:${c_0} \"review my staged changes with splus\""
printf '%b\n' "  ${c_dim}terminal:${c_0} splus review --staged    ${c_dim}·${c_0}    splus update"
