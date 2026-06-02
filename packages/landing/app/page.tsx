import Interactions from "@/components/Interactions";

const REPO = "https://github.com/kiwi-init/splus";
const ORG = "https://kiwiinit.com";
const INSTALL = "curl -fsSL https://splus.sh/install.sh | sh";

// ascii kiwi slice — the kiwi init mark
const KIWI = `  · | ·
·  \\|/  ·
──( o )──
·  /|\\  ·
  · | ·`;

export default function Home() {
  return (
    <>
      <a className="skip" href="#install">Skip to install</a>

      {/* header */}
      <header className="nav" id="top">
        <a className="brand" href="#top"><b>splus</b> — a kiwi init tool</a>
        <div className="nav-right">
          <a href={REPO} rel="noopener">GitHub ↗</a>
        </div>
      </header>

      <main>
        {/* hero */}
        <section className="hero">
          <div className="hero-copy">
            <h1 className="h1">
              Don&rsquo;t pay for another agent.<br />
              <span className="punch">Juice the one you&rsquo;ve got.</span>
            </h1>
            <p className="lede">
              Plug a deterministic reviewer into the coding agent you already run. It proves
              what&rsquo;s broken — and ignores the rest.
            </p>
            <p className="meta"><b>local</b> · <b>open source</b> · <b>mcp-native</b></p>
            <div className="actions">
              <a className="btn btn-solid btn-lg" href="#install">Install</a>
              <a className="btn btn-ghost btn-lg" href={REPO} rel="noopener">Source ↗</a>
            </div>
          </div>
          <figure className="hero-figure">
            <img className="hero-img" src="/hero.jpg" alt="" />
          </figure>
        </section>

        {/* install */}
        <div className="head reveal" id="install">
          <p className="label">Install</p>
          <h2>One line. Then ask your agent to review.</h2>
          <p>Drops the engine + a local MCP server into <code>~/.splus</code> and wires it into every coding agent it finds. No account, no key, nothing billed.</p>
        </div>
        <section className="install reveal">
          <div className="terminal">
            <div className="terminal-tabs" role="tablist">
              <button className="tab is-active" role="tab" data-tab="install">Install</button>
              <button className="tab" role="tab" data-tab="claude">Claude Code</button>
              <button className="tab" role="tab" data-tab="manual">Codex / OpenCode</button>
            </div>
            <div className="terminal-body">
              <div className="snippet is-active" data-pane="install">
                <pre><code><span className="c-prompt">$</span>{` ${INSTALL}`}</code></pre>
                <button className="copy" data-copy={INSTALL} aria-label="Copy command">copy</button>
              </div>
              <div className="snippet" data-pane="claude">
                <pre><code><span className="c-prompt">$</span>{" claude mcp add --scope user splus -- ~/.splus/bin/splus-mcp"}</code></pre>
                <button className="copy" data-copy="claude mcp add --scope user splus -- ~/.splus/bin/splus-mcp" aria-label="Copy command">copy</button>
              </div>
              <div className="snippet" data-pane="manual">
                <pre><code>{`# Codex — ~/.codex/config.toml
[mcp_servers.splus]
command = "~/.splus/bin/splus-mcp"

# OpenCode — ~/.config/opencode/opencode.json
{ "mcp": { "splus": { "type": "local",
  "command": ["~/.splus/bin/splus-mcp"], "enabled": true } } }`}</code></pre>
                <button className="copy" data-copy={`[mcp_servers.splus]\ncommand = "~/.splus/bin/splus-mcp"`} aria-label="Copy config">copy</button>
              </div>
            </div>
            <div className="term-foot">
              <span className="ok">▸</span> then say{" "}
              <span className="say">&quot;review my staged changes with splus&quot;</span>.
            </div>
          </div>
        </section>

        {/* the engine */}
        <div className="head reveal">
          <p className="label">The engine</p>
          <h2>Deterministic checks, every finding anchored.</h2>
          <p>A Rust engine over the tree-sitter AST of your diff — zero inference, fast, reproducible. Your agent only ever judges what survives.</p>
        </div>
        <ol className="specs reveal">
          <li className="spec">
            <div className="spec-key"><span className="spec-n">01</span> diff-scoped</div>
            <div className="spec-body">
              <h3>Only the lines you added</h3>
              <p>Generated, vendored, and lockfiles are skipped; circuit-breakers cap runaway diffs at 600 files. Legacy code is never re-litigated.</p>
            </div>
          </li>
          <li className="spec">
            <div className="spec-key"><span className="spec-n">02</span> secrets</div>
            <div className="spec-body">
              <h3>Keys, tokens, credentials</h3>
              <p>gitleaks-style rules with Shannon-entropy gating — pure Rust, no external tools, and the entropy gate kills placeholder false positives.</p>
            </div>
          </li>
          <li className="spec">
            <div className="spec-key"><span className="spec-n">03</span> complexity</div>
            <div className="spec-body">
              <h3>The delta, not the size</h3>
              <p>Cognitive complexity measured base→head — it flags the functions your change made harder to read, not the ones that were always big.</p>
            </div>
          </li>
          <li className="spec">
            <div className="spec-key"><span className="spec-n">04</span> blast radius</div>
            <div className="spec-body">
              <h3>What a change can break</h3>
              <p>Every cross-file caller of what you touched — compiler-grade from a SCIP index (~97%), honest name+import heuristics without. Each claim carries its confidence.</p>
            </div>
          </li>
          <li className="spec">
            <div className="spec-key"><span className="spec-n">05</span> adapters</div>
            <div className="spec-body">
              <h3>More tools when present</h3>
              <p>Opt-in semgrep, ast-grep, and osv-scanner run only if they&rsquo;re on PATH — and anything absent is reported as a coverage gap, never hidden.</p>
            </div>
          </li>
        </ol>

        {/* how it runs */}
        <div className="head reveal">
          <p className="label">How it runs</p>
          <h2>Your agent calls it — locally.</h2>
        </div>
        <ol className="specs reveal">
          <li className="spec">
            <div className="spec-key"><span className="spec-n">01</span> mcp</div>
            <div className="spec-body">
              <h3>Five tools over a local server</h3>
              <p><code>review</code>, <code>dismiss</code>, <code>mute</code>, <code>learnings</code>, <code>index</code> — over stdio, zero-network. Claude Code, Codex, OpenCode. Your agent stays the reviewer.</p>
            </div>
          </li>
          <li className="spec">
            <div className="spec-key"><span className="spec-n">02</span> it learns</div>
            <div className="spec-body">
              <h3>Dismiss once, it stays quiet</h3>
              <p>Three suppression tiers — exact, rule-mute, and semantic (cosine) — scoped per repo in <code>.splus-cache</code>. Precision compounds as it learns your noise.</p>
            </div>
          </li>
          <li className="spec">
            <div className="spec-key"><span className="spec-n">03</span> byo llm</div>
            <div className="spec-body">
              <h3>Optional, off by default</h3>
              <p>Set a key and it adds triage (Haiku) plus a deeper discovery pass (Opus) for the logic bugs determinism can&rsquo;t see. The deterministic path needs no model.</p>
            </div>
          </li>
          <li className="spec">
            <div className="spec-key"><span className="spec-n">04</span> local · MIT</div>
            <div className="spec-body">
              <h3>Nothing leaves your machine</h3>
              <p>Runs on your checkout — no account, no telemetry, nothing uploaded. Open source under MIT: read it, fork it, self-host it.</p>
            </div>
          </li>
        </ol>
      </main>

      {/* footer */}
      <footer className="foot">
        <a className="kiwi-sign" href={ORG} rel="noopener" aria-label="A Kiwi Init project — kiwiinit.com">
          <pre className="kiwi-ascii" aria-hidden="true">{KIWI}</pre>
          <span className="kiwi-by">
            <span className="kiwi-tag">a kiwi init project</span>
            <span className="kiwi-url">kiwiinit.com →</span>
          </span>
        </a>
        <p className="foot-legal">© <span data-year="">2026</span> splus · MIT</p>
      </footer>

      <Interactions />
    </>
  );
}
