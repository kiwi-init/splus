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
#                     downloading (expects splus-engine, mcp.cjs, optionally skills/) —
#                     used for local testing of this script
#   SPLUS_NO_MODIFY_PATH=1  don't touch shell rc files
#   SPLUS_NO_WIRE=1         don't auto-wire coding agents
#   SPLUS_NO_ADAPTERS=1     don't download the optional gitleaks/osv-scanner adapters
#   SPLUS_UPDATE=1          force compact update mode (auto-detected for existing installs)
#   SPLUS_REWIRE=1          re-wire coding agents during an update
set -eu

REPO="kiwi-init/splus"
INSTALL_DIR="${SPLUS_INSTALL_DIR:-$HOME/.splus}"
BIN_DIR="$INSTALL_DIR/bin"
LIB_DIR="$INSTALL_DIR/lib"
MCP_BIN="$BIN_DIR/splus-mcp"
previous_version=""
[ -f "$INSTALL_DIR/version" ] && previous_version=$(cat "$INSTALL_DIR/version" 2>/dev/null || true)
updating=0
if [ -n "${SPLUS_UPDATE:-}" ] || [ -x "$BIN_DIR/splus-engine" ] || [ -f "$LIB_DIR/mcp.cjs" ]; then
  updating=1
fi

c_b='\033[1m'; c_dim='\033[2m'; c_grn='\033[32m'; c_red='\033[31m'; c_0='\033[0m'
say()  { printf '%b\n' "${c_dim}splus${c_0} $*"; }
detail() { [ "$updating" -eq 1 ] || say "$@"; }
ok()   { printf '%b\n' "  ${c_grn}✓${c_0} $*"; }
warn() { printf '%b\n' "  ${c_red}!${c_0} $*"; }
die()  { printf '%b\n' "${c_red}splus: $*${c_0}" >&2; exit 1; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else return 1
  fi
}

verify_manifest() {
  file=$1 manifest=$2 name=$3
  if [ -n "${SPLUS_INSECURE:-}" ]; then
    warn "SPLUS_INSECURE=1 — skipping checksum verification for $name"
    return 0
  fi
  sum=$(sha256_file "$file") || return 1
  want=$(awk -v a="$name" '{ n=$2; sub(/^\*/, "", n); if (n == a) { print $1; exit } }' "$manifest")
  [ -n "$want" ] && [ "$sum" = "$want" ]
}

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

if [ "$updating" -eq 1 ]; then
  from=${previous_version:-installed}
  if [ "$from" = "latest" ]; then
    say "updating on ${os}-${arch}"
  else
    say "updating ${c_b}${from}${c_0} on ${os}-${arch}"
  fi
else
  say "installing for ${c_b}${os}-${arch}${c_0} → ${INSTALL_DIR}"
fi
mkdir -p "$BIN_DIR" "$LIB_DIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --- fetch artifacts -------------------------------------------------------
if [ -n "${SPLUS_LOCAL_DIST:-}" ]; then
  detail "using local dist: $SPLUS_LOCAL_DIST"
  cp "$SPLUS_LOCAL_DIST/splus-engine" "$tmp/" || die "missing splus-engine in SPLUS_LOCAL_DIST"
  cp "$SPLUS_LOCAL_DIST/mcp.cjs" "$tmp/" || die "missing mcp.cjs in SPLUS_LOCAL_DIST"
  [ -d "$SPLUS_LOCAL_DIST/skills" ] && cp -R "$SPLUS_LOCAL_DIST/skills" "$tmp/skills"
  version="local"
else
  if command -v curl >/dev/null 2>&1; then dl() { curl -fsSL "$1" -o "$2"; }
  elif command -v wget >/dev/null 2>&1; then dl() { wget -qO "$2" "$1"; }
  else die "need curl or wget to download."; fi

  ver="${SPLUS_VERSION:-latest}"
  if [ "$ver" = "latest" ]; then base="https://github.com/$REPO/releases/latest/download"
  else base="https://github.com/$REPO/releases/download/$ver"; fi
  version="$ver"

  detail "downloading $asset ($ver)"
  dl "$base/$asset" "$tmp/$asset" || die "download failed: $base/$asset (no release for ${os}-${arch}?)"

  # Verify integrity. For a real release this is MANDATORY — never install an
  # unverified binary that's about to run on your machine. SPLUS_INSECURE=1
  # overrides (e.g. a private mirror that publishes no sums).
  if [ -n "${SPLUS_INSECURE:-}" ]; then
    warn "SPLUS_INSECURE=1 — skipping checksum verification"
  else
    dl "$base/SHA256SUMS" "$tmp/SHA256SUMS" \
      || die "could not fetch SHA256SUMS for $ver — refusing to install unverified (SPLUS_INSECURE=1 to override)"
    verify_manifest "$tmp/$asset" "$tmp/SHA256SUMS" "$asset" \
      || die "checksum mismatch or missing checksum for $asset"
    ok "checksum verified"
  fi
  tar -xzf "$tmp/$asset" -C "$tmp" || die "extract failed"
fi

# --- place binaries + wrappers --------------------------------------------
install -m 0755 "$tmp/splus-engine" "$BIN_DIR/splus-engine"
install -m 0644 "$tmp/mcp.cjs" "$LIB_DIR/mcp.cjs"

cat > "$BIN_DIR/splus-mcp" <<EOF
#!/bin/sh
export SPLUS_ENGINE="\${SPLUS_ENGINE:-$BIN_DIR/splus-engine}"
exec node "$LIB_DIR/mcp.cjs" "\$@"
EOF
chmod 0755 "$BIN_DIR/splus-mcp"

# Keep a tiny update command even though the old full CLI was retired in v0.9.
# It enters compact update mode directly, avoiding the old URL preamble and
# first-install onboarding on every upgrade.
cat > "$BIN_DIR/splus" <<EOF
#!/bin/sh
set -eu
case "\${1:-}" in
  update)
    export SPLUS_UPDATE=1
    export SPLUS_INSTALL_DIR="\${SPLUS_INSTALL_DIR:-$INSTALL_DIR}"
    tmp=\$(mktemp)
    trap 'rm -f "\$tmp"' EXIT
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL https://splus.sh/install.sh -o "\$tmp"
    elif command -v wget >/dev/null 2>&1; then
      wget -qO "\$tmp" https://splus.sh/install.sh
    else
      echo "splus: curl or wget is required to update" >&2
      exit 1
    fi
    sh "\$tmp"
    ;;
  --version|version)
    cat "\${SPLUS_INSTALL_DIR:-$INSTALL_DIR}/version"
    ;;
  *)
    echo "usage: splus update | splus version" >&2
    exit 2
    ;;
esac
EOF
chmod 0755 "$BIN_DIR/splus"
printf '%s\n' "$version" > "$INSTALL_DIR/version"

# The review-protocol skills — the canonical copy lives in ~/.splus/skills; the
# agent wiring below copies/points each coding agent at it. The protocol is a
# first-class artifact: agents load it explicitly instead of depending on MCP
# tool descriptions being read.
if [ -d "$tmp/skills" ]; then
  rm -rf "$INSTALL_DIR/skills"
  cp -R "$tmp/skills" "$INSTALL_DIR/skills"
fi

if [ "$updating" -eq 1 ]; then
  ok "core updated"
else
  ok "installed splus, splus-mcp, splus-engine → $BIN_DIR"
fi

# --- optional: provision external adapters (best-effort) -------------------
# The engine ships native, local detectors (secrets + injection/deser/TLS sinks).
# These adapters EXTEND that coverage and the engine auto-detects them on PATH
# ($BIN_DIR): gitleaks (MIT, broader secret patterns, fully local) and osv-scanner
# (dependency CVEs — the one network call Splus can make, and only when a lockfile
# changed). Best-effort: a failed adapter download never aborts the install.
# Skip entirely with SPLUS_NO_ADAPTERS=1 (e.g. air-gapped installs).
if [ -z "${SPLUS_NO_ADAPTERS:-}" ] && { command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; }; then
  if command -v curl >/dev/null 2>&1; then afetch() { curl -fsSL "$1" -o "$2"; }
  else afetch() { wget -qO "$2" "$1"; }; fi
  detail "provisioning adapters (skip with SPLUS_NO_ADAPTERS=1)"
  adapters_installed=""

  # gitleaks — diff-scoped secret scanning (asset arch matches ours: arm64/x64).
  gl_ver="8.30.1"
  gl_asset="gitleaks_${gl_ver}_${os}_${arch}.tar.gz"
  atmp=$(mktemp -d)
  gl_base="https://github.com/gitleaks/gitleaks/releases/download/v${gl_ver}"
  if afetch "$gl_base/$gl_asset" "$atmp/$gl_asset" 2>/dev/null \
     && afetch "$gl_base/gitleaks_${gl_ver}_checksums.txt" "$atmp/checksums.txt" 2>/dev/null \
     && verify_manifest "$atmp/$gl_asset" "$atmp/checksums.txt" "$gl_asset" \
     && tar -xzf "$atmp/$gl_asset" -C "$atmp" gitleaks 2>/dev/null \
     && install -m 0755 "$atmp/gitleaks" "$BIN_DIR/gitleaks"; then
    adapters_installed="gitleaks"
  else
    rm -f "$BIN_DIR/gitleaks"
    warn "gitleaks adapter skipped (download or checksum verification failed)"
  fi
  rm -rf "${atmp:?}"

  # osv-scanner — dependency CVEs (osv uses amd64; we call x64 → map it).
  osv_arch="$arch"; [ "$arch" = "x64" ] && osv_arch="amd64"
  osv_ver="2.3.8"
  osv_asset="osv-scanner_${os}_${osv_arch}"
  atmp=$(mktemp -d)
  osv_base="https://github.com/google/osv-scanner/releases/download/v${osv_ver}"
  if afetch "$osv_base/$osv_asset" "$atmp/$osv_asset" 2>/dev/null \
     && afetch "$osv_base/osv-scanner_SHA256SUMS" "$atmp/checksums.txt" 2>/dev/null \
     && verify_manifest "$atmp/$osv_asset" "$atmp/checksums.txt" "$osv_asset" \
     && install -m 0755 "$atmp/$osv_asset" "$BIN_DIR/osv-scanner"; then
    if [ -n "$adapters_installed" ]; then adapters_installed="$adapters_installed, osv-scanner"
    else adapters_installed="osv-scanner"; fi
  else
    rm -f "$BIN_DIR/osv-scanner"
    warn "osv-scanner adapter skipped (download or checksum verification failed)"
  fi
  rm -rf "${atmp:?}"
  [ -z "$adapters_installed" ] || ok "adapters verified: $adapters_installed"
fi

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
      warn "open a new shell (or run: export PATH=\"$BIN_DIR:\$PATH\") to use \`splus-engine\` directly"
    fi
    ;;
esac

# --- wire coding agents ----------------------------------------------------
wired=0
if [ -z "${SPLUS_NO_WIRE:-}" ] && { [ "$updating" -eq 0 ] || [ -n "${SPLUS_REWIRE:-}" ]; }; then
  say "wiring coding agents"

  # Claude Code — use its CLI (idempotent: remove then add).
  if command -v claude >/dev/null 2>&1; then
    claude mcp remove --scope user splus >/dev/null 2>&1 || true
    if claude mcp add --scope user splus -- "$MCP_BIN" >/dev/null 2>&1; then
      ok "Claude Code"; wired=1
    else warn "Claude Code detected but \`claude mcp add\` failed — add manually: claude mcp add --scope user splus -- $MCP_BIN"; fi
  fi

  # Codex — idempotent: if already in config.toml, done; else CLI, else append.
  if command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]; then
    toml="$HOME/.codex/config.toml"
    if grep -q '^\[mcp_servers.splus\]' "$toml" 2>/dev/null; then
      ok "Codex (already configured)"; wired=1
    elif command -v codex >/dev/null 2>&1 && codex mcp add splus -- "$MCP_BIN" >/dev/null 2>&1; then
      ok "Codex"; wired=1
    else
      mkdir -p "$HOME/.codex"
      printf '\n[mcp_servers.splus]\ncommand = "%s"\n' "$MCP_BIN" >> "$toml"
      ok "Codex (~/.codex/config.toml)"; wired=1
    fi
  fi

  # OpenCode — merge into the config (node is guaranteed present). NEVER clobber:
  # if the file exists but doesn't parse, leave it untouched and warn.
  if command -v opencode >/dev/null 2>&1 || [ -d "$HOME/.config/opencode" ]; then
    mkdir -p "$HOME/.config/opencode"
    ocf="$HOME/.config/opencode/opencode.json"
    [ -f "$HOME/.config/opencode/opencode.jsonc" ] && ocf="$HOME/.config/opencode/opencode.jsonc"
    if SPLUS_OCF="$ocf" SPLUS_MCPBIN="$MCP_BIN" node <<'EOF'
const fs = require("fs");
const f = process.env.SPLUS_OCF, bin = process.env.SPLUS_MCPBIN;
let raw = null;
try { raw = fs.readFileSync(f, "utf8"); } catch {}
let cfg = {};
if (raw && raw.trim()) {
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    // Exists but won't parse (comments, trailing comma, partial write). Refuse
    // to overwrite the user's config — warning beats clobbering their settings.
    console.error("could not parse " + f + " (" + (e.message || e) + ")");
    process.exit(3);
  }
}
cfg["$schema"] = cfg["$schema"] || "https://opencode.ai/config.json";
cfg.mcp = cfg.mcp || {};
cfg.mcp.splus = { type: "local", command: [bin], enabled: true };
fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
EOF
    then ok "OpenCode ($ocf)"; wired=1
    else warn "OpenCode config left untouched (it didn't parse) — add splus to $ocf by hand"; fi
  fi

  [ "$wired" = 1 ] || warn "no coding agent detected — register \`$MCP_BIN\` as an MCP server manually"
fi

# --- install the review protocol as agent skills ----------------------------
# The skills ARE the product's review protocol — installing them per agent makes
# the protocol explicit and user-invocable instead of depending on the agent
# happening to read MCP tool descriptions. Unlike MCP wiring, this also runs on
# updates: a refreshed protocol is half the point of `splus update`.
if [ -z "${SPLUS_NO_WIRE:-}" ] && [ -d "$INSTALL_DIR/skills" ]; then
  detail "installing agent skills"

  # The SKILL.md body without its Claude-specific YAML frontmatter.
  skill_body() { awk 'f>1 {print} /^---$/ {f++}' "$1"; }
  # The one-line description from the frontmatter (for OpenCode's command header).
  skill_desc() { awk '/^description: /{sub(/^description: /,""); print; exit}' "$1"; }
  # Point non-Claude agents at the canonical per-stage reference files.
  skill_refs() {
    [ -d "$INSTALL_DIR/skills/$1/references" ] || return 0
    printf '\n> Stage protocols — read each file in %s/skills/%s/references/ as you reach that stage.\n' "$INSTALL_DIR" "$1"
  }

  # Claude Code — native skills (auto-triggered by name + user-invocable).
  if command -v claude >/dev/null 2>&1 || [ -d "$HOME/.claude" ]; then
    mkdir -p "$HOME/.claude/skills"
    for s in review prefs; do
      [ -d "$INSTALL_DIR/skills/$s" ] || continue
      rm -rf "$HOME/.claude/skills/splus-$s"
      cp -R "$INSTALL_DIR/skills/$s" "$HOME/.claude/skills/splus-$s"
    done
    ok "Claude Code skills (splus-review, splus-prefs)"
  fi

  # Codex — custom prompts, slash-invocable (/splus-review).
  if command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]; then
    mkdir -p "$HOME/.codex/prompts"
    for s in review prefs; do
      [ -f "$INSTALL_DIR/skills/$s/SKILL.md" ] || continue
      { skill_body "$INSTALL_DIR/skills/$s/SKILL.md"; skill_refs "$s"; } > "$HOME/.codex/prompts/splus-$s.md"
    done
    ok "Codex prompts (/splus-review, /splus-prefs)"
  fi

  # OpenCode — commands, slash-invocable (/splus-review).
  if command -v opencode >/dev/null 2>&1 || [ -d "$HOME/.config/opencode" ]; then
    mkdir -p "$HOME/.config/opencode/command"
    for s in review prefs; do
      [ -f "$INSTALL_DIR/skills/$s/SKILL.md" ] || continue
      {
        printf -- '---\ndescription: %s\n---\n' "$(skill_desc "$INSTALL_DIR/skills/$s/SKILL.md")"
        skill_body "$INSTALL_DIR/skills/$s/SKILL.md"
        skill_refs "$s"
      } > "$HOME/.config/opencode/command/splus-$s.md"
    done
    ok "OpenCode commands (/splus-review, /splus-prefs)"
  fi
fi

# --- done ------------------------------------------------------------------
if [ "$updating" -eq 1 ]; then
  printf '\n%b\n' "${c_grn}${c_b}Splus is up to date.${c_0}"
else
  printf '\n%b\n' "${c_grn}${c_b}Splus is installed.${c_0}"
  printf '%b\n' "  ${c_dim}then, in your agent:${c_0} /splus-review  ${c_dim}(or \"review my staged changes with splus\")${c_0}"
  printf '%b\n' "  ${c_dim}update:${c_0} splus update"
fi
