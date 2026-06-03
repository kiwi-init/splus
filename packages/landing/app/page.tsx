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
      </header>

      <main>
        {/* hero */}
        <section className="hero">
          <div className="hero-copy">
            <h1 className="h1">
              local infra for<br />
              <span className="punch">code review agents.</span>
            </h1>
            <p className="lede">
              Plug the review engine into the coding agent you already run. Claude, Codex or OpenCode.
            </p>
            <div className="actions">
              <a className="btn btn-solid btn-lg" href="#install">Install</a>
              <a className="btn btn-ghost btn-lg" href="#benchmark">Benchmark</a>
              <a className="btn btn-ghost btn-lg" href={REPO} rel="noopener">Source</a>
            </div>
          </div>
          <figure className="hero-figure">
            <img className="hero-img" src="/hero.jpg" alt="" />
          </figure>
        </section>

        {/* install */}
        <div className="head reveal" id="install">
          <p className="label">Install</p>
          <h2>One line, then ask your agent to review.</h2>
          <p>Installs the engine and a local MCP server into <code>~/.splus</code>, then wires up every coding agent it finds. No account, no key.</p>
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
              then say <span className="say">&quot;review my staged changes with splus&quot;</span>.
            </div>
          </div>
        </section>

        {/* the engine */}
        <div className="head reveal">
          <p className="label">The engine</p>
          <h2>Deterministic checks. Every finding has an anchor.</h2>
          <p>A Rust engine reads the tree-sitter AST of your diff. No inference, fully repeatable — the agent only judges what&rsquo;s left.</p>
        </div>
        <ol className="specs reveal">
          <li className="spec">
            <div className="spec-key"><span className="spec-n">01</span> diff-scoped</div>
            <div className="spec-body">
              <h3>Only the lines you added</h3>
              <p>Generated, vendored, and lockfile paths are skipped. Large diffs are capped at 600 files, not crawled.</p>
            </div>
          </li>
          <li className="spec">
            <div className="spec-key"><span className="spec-n">02</span> secrets</div>
            <div className="spec-body">
              <h3>Keys, tokens, credentials</h3>
              <p>gitleaks-style rules with an entropy check, in pure Rust. No external tools, and the entropy gate drops placeholder matches.</p>
            </div>
          </li>
          <li className="spec">
            <div className="spec-key"><span className="spec-n">03</span> complexity</div>
            <div className="spec-body">
              <h3>The delta, not the size</h3>
              <p>Cognitive complexity measured before and after your change. It flags functions you made harder to read, not ones that were always big.</p>
            </div>
          </li>
          <li className="spec">
            <div className="spec-key"><span className="spec-n">04</span> blast radius</div>
            <div className="spec-body">
              <h3>What a change can break</h3>
              <p>Every caller of what you changed, across files. Compiler-grade with a SCIP index (~97%), name-and-import heuristics without. Each result shows its confidence.</p>
            </div>
          </li>
          <li className="spec">
            <div className="spec-key"><span className="spec-n">05</span> adapters</div>
            <div className="spec-body">
              <h3>More tools when present</h3>
              <p>If semgrep, ast-grep, or osv-scanner are on your PATH, splus runs them too. What&rsquo;s missing is reported, not hidden.</p>
            </div>
          </li>
        </ol>

        {/* how it runs */}
        <div className="head reveal">
          <p className="label">How it runs</p>
          <h2>Your agent calls it. Locally.</h2>
        </div>
        <ol className="specs reveal">
          <li className="spec">
            <div className="spec-key"><span className="spec-n">01</span> mcp</div>
            <div className="spec-body">
              <h3>Five tools over a local server</h3>
              <p>A local stdio server with five tools — <code>review</code>, <code>dismiss</code>, <code>mute</code>, <code>learnings</code>, <code>index</code>. No network. Your agent stays the reviewer.</p>
            </div>
          </li>
          <li className="spec">
            <div className="spec-key"><span className="spec-n">02</span> it learns</div>
            <div className="spec-body">
              <h3>Dismiss once, it stays quiet</h3>
              <p>Dismiss a finding and it stops coming back — by exact match, by rule, or by similarity. Learned per repo, in <code>.splus-cache</code>.</p>
            </div>
          </li>
          <li className="spec">
            <div className="spec-key"><span className="spec-n">03</span> byo llm</div>
            <div className="spec-body">
              <h3>Optional, off by default</h3>
              <p>Add a key to turn on triage (Haiku) and a deeper discovery pass (Opus) for logic bugs. Off by default; the engine needs no model.</p>
            </div>
          </li>
          <li className="spec">
            <div className="spec-key"><span className="spec-n">04</span> local · MIT</div>
            <div className="spec-body">
              <h3>Nothing leaves your machine</h3>
              <p>Runs on your checkout. No account, no telemetry, no uploads. MIT-licensed — read it, fork it, self-host it.</p>
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
            <span className="kiwi-url">kiwiinit.com</span>
          </span>
        </a>
        <p className="foot-legal">© <span data-year="">2026</span> splus · MIT</p>
      </footer>

      <Interactions />
    </>
  );
}
