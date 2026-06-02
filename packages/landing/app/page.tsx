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

// the loop, built on a fixed grid so the columns can never drift
const pad = (s: string, n = 12) => {
  const total = n - [...s].length;
  const left = Math.floor(total / 2);
  return " ".repeat(left) + s + " ".repeat(total - left);
};
const bar = "─".repeat(12);
const top = `┌${bar}┐`;
const bot = `└${bar}┘`;
const GAP = " ".repeat(7);
const ARR = "  ───→ "; // 7 cells wide, matches GAP
const COLS = [
  ["your agent", "claude·codex"],
  ["splus", "rust engine"],
  ["real bugs", "nothing else"],
];
const FLOW = [
  [top, top, top].join(GAP),
  COLS.map((c) => `│${pad(c[0])}│`).join(ARR),
  COLS.map((c) => `│${pad(c[1])}│`).join(ARR),
  [bot, bot, bot].join(GAP),
].join("\n");

export default function Home() {
  return (
    <>
      <a className="skip" href="#install">Skip to install</a>

      <div className="atmosphere" aria-hidden="true">
        <div className="grid-paper" />
        <div className="scanlines" />
      </div>

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
              <span className="juice">Juice the one you&rsquo;ve got.</span>
            </h1>
            <p className="lede">
              splus drops a deterministic review engine into the coding agent you already run —
              Claude&nbsp;Code, Codex, OpenCode. It reads your diff, proves what&rsquo;s broken, and
              hands back only what&rsquo;s worth fixing. Local, open source, no new subscription.
            </p>
            <div className="actions">
              <a className="btn btn-solid btn-lg" href="#install">Install</a>
              <a className="btn btn-ghost btn-lg" href={REPO} rel="noopener">Source ↗</a>
            </div>
          </div>
          <figure className="hero-figure">
            <img className="hero-img" src="/hero.jpg" alt="" />
          </figure>
        </section>

        {/* ascii */}
        <section className="ascii reveal">
          <div className="ascii-frame">
            <pre className="ascii-art" aria-hidden="true">{FLOW}</pre>
          </div>
          <p className="ascii-cap">splus sits between your agent and your diff — it returns only what&rsquo;s worth fixing.</p>
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

        {/* the tooling */}
        <div className="head reveal">
          <p className="label">The tooling</p>
          <h2>What the engine actually does.</h2>
          <p>Most of the work is deterministic — fast, reproducible, zero inference. Your agent only judges what survives.</p>
        </div>
        <section className="grid2 reveal">
          <div className="cell">
            <span className="k">diff-scoped</span>
            <h3>Only the lines you added</h3>
            <p>Tree-sitter parses the diff and drops everything your change didn&rsquo;t touch. Legacy code is never re-litigated.</p>
          </div>
          <div className="cell">
            <span className="k">collectors</span>
            <h3>Deterministic checks, anchored</h3>
            <p>Secrets, cognitive-complexity deltas, SAST, duplication — each finding tied to hard evidence: a match, a metric, a graph edge.</p>
          </div>
          <div className="cell">
            <span className="k">blast radius</span>
            <h3>What a change can break</h3>
            <p>A cross-file call graph resolves every caller of what you touched — compiler-grade with a SCIP index, honest heuristics without.</p>
          </div>
          <div className="cell">
            <span className="k">suppression</span>
            <h3>It learns your noise</h3>
            <p>Dismiss a finding once and the whole class goes quiet. Learnings live in <code>.splus-cache</code>, in your repo.</p>
          </div>
        </section>

        {/* features */}
        <div className="head reveal">
          <p className="label">Features</p>
          <h2>Yours, on your machine.</h2>
        </div>
        <section className="grid2 reveal">
          <div className="cell">
            <span className="k">local</span>
            <h3>Nothing leaves your machine</h3>
            <p>The engine runs on your checkout. No accounts, no telemetry, no diffs uploaded.</p>
          </div>
          <div className="cell">
            <span className="k">mcp-native</span>
            <h3>Your agent calls it</h3>
            <p>One MCP server, every coding agent — Claude Code, Codex, OpenCode.</p>
          </div>
          <div className="cell">
            <span className="k">open source</span>
            <h3>MIT — read it, fork it</h3>
            <p>The engine is the source of truth. Audit every line; self-host the whole thing.</p>
          </div>
          <div className="cell">
            <span className="k">byo llm</span>
            <h3>Bring your own model</h3>
            <p>Provider-neutral, and off by default. The deterministic pass needs no LLM at all.</p>
          </div>
        </section>
      </main>

      {/* footer */}
      <footer className="foot">
        <div className="foot-left">
          <a className="brand" href="#top"><b>splus</b> — a kiwi init tool</a>
          <a className="kiwi-sign" href={ORG} rel="noopener" aria-label="A Kiwi Init project — kiwiinit.com">
            <pre className="kiwi-ascii" aria-hidden="true">{KIWI}</pre>
            <span className="kiwi-by">
              <span className="kiwi-tag">a kiwi init project</span>
              <span className="kiwi-url">kiwiinit.com →</span>
            </span>
          </a>
        </div>
        <nav className="foot-links" aria-label="Footer">
          <a href={REPO} rel="noopener">GitHub</a>
          <a href="https://splus.sh/install.sh">install.sh</a>
          <a href={ORG} rel="noopener">Kiwi Init ↗</a>
        </nav>
        <p className="foot-legal">© <span data-year="">2026</span> splus · a kiwi init tool · MIT</p>
      </footer>

      <Interactions />
    </>
  );
}
