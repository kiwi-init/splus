import Interactions from "@/components/Interactions";

const REPO = "https://github.com/kiwi-init/splus";
const ORG = "https://kiwiinit.com";
const INSTALL = "curl -fsSL https://splus.sh/install.sh | sh";

// ascii kiwi slice — seeds radiating from a pale core (the Kiwi Init mark)
const KIWI = `  · | ·
·  \\|/  ·
──( o )──
·  /|\\  ·
  · | ·`;

export default function Home() {
  return (
    <>
      <a className="skip" href="#install">Skip to install</a>

      {/* atmosphere */}
      <div className="atmosphere" aria-hidden="true">
        <div className="grid-paper" />
        <div className="glow glow-a" />
        <div className="glow glow-b" />
        <div className="scanlines" />
      </div>

      {/* nav */}
      <header className="nav">
        <a className="brand" href="#top" aria-label="S+ home">
          <svg className="brand-mark" width="24" height="24" viewBox="0 0 26 26" aria-hidden="true">
            <path d="M2 13 H7 L9.5 6 L13.5 20 L16.5 13 H24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="brand-word">S<span className="brand-plus">+</span></span>
        </a>
        <a className="brand-by" href={ORG} rel="noopener">a <b>kiwi&nbsp;init</b> project</a>
        <nav className="nav-links" aria-label="Primary">
          <a href="#how">How it works</a>
          <a href="#precision">Precision</a>
          <a href="#local">Local</a>
          <a href={REPO} rel="noopener">GitHub</a>
        </nav>
        <div className="nav-cta">
          <a className="btn btn-ghost" href={REPO} rel="noopener">Star on GitHub</a>
          <a className="btn btn-solid" href="#install">Install</a>
        </div>
      </header>

      <main id="top">
        {/* hero */}
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow"><span className="blip" />Open-source · local-first code review</p>
            <h1 className="display">
              Only the comments<br />
              <span className="hl-signal">worth reading.</span>
            </h1>
            <p className="lede">
              Most AI reviewers bury real bugs under false positives. S+ is{" "}
              <strong>deterministic-first</strong>: it reviews only new lines, proves every
              finding, maps the blast radius across files, and learns the noise you wave off.
              One install wires it into your coding agent — and nothing ever leaves your machine.
            </p>
            <div className="hero-actions">
              <a className="btn btn-solid btn-lg" href="#install">Install — one line →</a>
              <a className="btn btn-ghost btn-lg" href={REPO} rel="noopener">View source</a>
            </div>
            <p className="hero-foot">
              <span className="tick">open source (MIT)</span>
              <span className="tick">no account, no key</span>
              <span className="tick">nothing leaves your machine</span>
            </p>
          </div>

          <figure className="scope" aria-label="An ASCII signalscope: a strong signal wave above a flat noise floor">
            <div className="scope-frame">
              <div className="scope-head">
                <span className="scope-led" />
                SIGNAL / NOISE
                <span className="scope-readout" data-snr="">SNR 19.0 dB</span>
              </div>
              <pre className="scope-wave" aria-hidden="true">▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▁▂▃▄▅▆▇█▇▆▅▄▃▂▁</pre>
              <div className="scope-grid-row" aria-hidden="true">└─────────┴─────────┴─────────┴─────────┴─────────┴────────┘</div>
              <pre className="scope-noise" aria-hidden="true">·  ·   ·  · ·    ·   ·  ·  ·    · ·   ·  ·   ·  ·  ·   · ·  ·  ·</pre>
              <div className="scope-foot">
                <span className="sig"><i style={{ background: "var(--ink)" }} />signal — real findings</span>
                <span className="sig"><i style={{ background: "var(--noise)" }} />noise — false positives</span>
                <span className="scope-foot-r">clean-as-you-code · diff-scoped</span>
              </div>
            </div>
          </figure>
        </section>

        {/* ticker */}
        <div className="ticker" aria-hidden="true">
          <div className="ticker-track">
            {Array.from({ length: 2 }).flatMap((_, i) =>
              [
                "deterministic engine",
                "clean-as-you-code",
                "cross-file blast radius",
                "every finding has an anchor",
                "learns your noise",
                "bring your own LLM",
                "runs 100% locally",
              ].flatMap((t, j) => [
                <span key={`${i}-${j}-t`}>{t}</span>,
                <span key={`${i}-${j}-d`} className="dot">+</span>,
              ]),
            )}
          </div>
        </div>

        {/* install */}
        <section id="install" className="install reveal">
          <div className="section-head">
            <p className="kicker">01 — Install</p>
            <h2>One line. Then ask your agent to review.</h2>
            <p className="sub">
              The installer drops the deterministic engine + a local MCP server into{" "}
              <code>~/.splus</code> and wires it into every coding agent it finds — Claude Code,
              Codex, OpenCode. No account, no token, nothing billed.
            </p>
          </div>

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

            <div className="terminal-foot">
              <span className="ok">▸</span> then say{" "}
              <span className="say">&quot;review my staged changes with splus&quot;</span>
              {" "}— you&rsquo;ll get findings with blast radius and a one-tap way to teach away the noise.
            </div>
          </div>
        </section>

        {/* precision metric */}
        <section id="precision" className="precision">
          <div className="section-head reveal">
            <p className="kicker">02 — The only metric that matters</p>
            <h2>Precision, not catch-rate.</h2>
            <p className="sub">
              A reviewer that flags everything is just noise with extra steps. We optimize{" "}
              <strong>precision</strong> — the share of comments you actually act on — and it climbs
              as S+ learns each repo. The gap below is your signal-to-noise.
            </p>
          </div>

          <figure className="chart reveal">
            <svg className="chart-svg" viewBox="0 0 720 380" role="img" aria-label="Precision rising toward 95% while false-positive rate falls toward 5% as S+ learns the repo">
              <defs>
                <linearGradient id="gap" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--signal)" stopOpacity=".10" />
                  <stop offset="1" stopColor="var(--signal)" stopOpacity="0" />
                </linearGradient>
              </defs>

              <g className="chart-grid" stroke="currentColor">
                <line x1="60" y1="40" x2="680" y2="40" /><line x1="60" y1="110" x2="680" y2="110" />
                <line x1="60" y1="180" x2="680" y2="180" /><line x1="60" y1="250" x2="680" y2="250" />
                <line x1="60" y1="320" x2="680" y2="320" />
              </g>
              <g className="chart-axis" fill="currentColor">
                <text x="48" y="44" textAnchor="end">1.0</text>
                <text x="48" y="114" textAnchor="end">.75</text>
                <text x="48" y="184" textAnchor="end">.50</text>
                <text x="48" y="254" textAnchor="end">.25</text>
                <text x="48" y="324" textAnchor="end">0</text>
              </g>

              <path className="chart-gap" d="M60,146 L137,130 L215,113 L292,96 L370,82 L447,71 L525,62 L602,57 L680,54 L680,306 L602,303 L525,300 L447,292 L370,281 L292,267 L215,250 L137,233 L60,214 Z" fill="url(#gap)" />

              <path className="line-noise" d="M60,214 L137,233 L215,250 L292,267 L370,281 L447,292 L525,300 L602,303 L680,306" fill="none" stroke="var(--noise)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              <path className="line-signal" d="M60,146 L137,130 L215,113 L292,96 L370,82 L447,71 L525,62 L602,57 L680,54" fill="none" stroke="var(--signal)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />

              <circle className="dot-signal" cx="680" cy="54" r="4.5" fill="var(--accent)" />
              <circle className="dot-noise" cx="680" cy="306" r="4.5" fill="var(--noise)" />

              <text className="lab lab-signal" x="676" y="40" textAnchor="end" fill="var(--accent)">precision 95%</text>
              <text className="lab lab-noise" x="676" y="326" textAnchor="end" fill="var(--noise)">false positives 5%</text>
              <text className="chart-x" x="370" y="360" textAnchor="middle" fill="currentColor">reviews over time →</text>
            </svg>
            <figcaption>
              Illustrative. Every finding is reproducible from its anchor — precision is something
              you can verify locally, not a slogan.
            </figcaption>
          </figure>

          <div className="stat-row reveal">
            <div className="stat"><b>only new lines</b><span>legacy code is never re-litigated</span></div>
            <div className="stat"><b>0 inference</b><span>by default — your agent does the judging</span></div>
            <div className="stat"><b>every finding</b><span>cites a deterministic anchor, not a vibe</span></div>
            <div className="stat"><b>compounding</b><span>each dismissal quiets a whole class</span></div>
          </div>
        </section>

        {/* how it works */}
        <section id="how" className="how">
          <div className="section-head reveal">
            <p className="kicker">03 — How it works</p>
            <h2>Deterministic first. The model only judges.</h2>
            <p className="sub">
              Most of the work happens with zero inference — fast, reproducible, and cheap. Your
              agent (or an optional local LLM pass) is downstream, and only ever sees what survived.
            </p>
          </div>

          <ol className="steps">
            <li className="step reveal">
              <span className="step-n">1</span>
              <h3>Parse the diff, keep only what&rsquo;s new</h3>
              <p>Tree-sitter builds symbols; <em>clean-as-you-code</em> throws away every line your change didn&rsquo;t add. No legacy noise, ever.</p>
            </li>
            <li className="step reveal">
              <span className="step-n">2</span>
              <h3>Run deterministic collectors</h3>
              <p>Secrets, cognitive-complexity deltas, SAST, duplication — each finding anchored to hard evidence: a match, a metric, a graph edge.</p>
            </li>
            <li className="step reveal">
              <span className="step-n">3</span>
              <h3>Map the blast radius</h3>
              <p>A cross-file call graph resolves who depends on what you touched — at compiler-grade SCIP precision when an index is present.</p>
            </li>
            <li className="step reveal">
              <span className="step-n">4</span>
              <h3>Suppress, then judge</h3>
              <p>Your repo&rsquo;s learned filter drops known noise. Only then does your agent triage what&rsquo;s left — or an optional local LLM pass, if you set a key.</p>
            </li>
          </ol>
        </section>

        {/* moat */}
        <section className="moat">
          <div className="moat-copy reveal">
            <p className="kicker">04 — The edge</p>
            <h2>It tells you what a change can break.</h2>
            <p className="sub">
              Line-by-line reviewers see a function in isolation. S+ sees the graph: change a
              signature and it surfaces every caller across the codebase, flags the ones that cross
              an API boundary, and tells you how sure it is.
            </p>
            <ul className="moat-list">
              <li><span className="b-mint">PRECISE</span> compiler-grade resolution from a SCIP index — ~97% confidence.</li>
              <li><span className="b-dim">HEURISTIC</span> name + import fallback when no index exists — honestly labeled.</li>
              <li><span className="b-dim">HONEST</span> every blast-radius claim carries its own confidence.</li>
            </ul>
          </div>

          <figure className="graph reveal" aria-label="A changed function and its callers across three files">
            <div className="graph-frame">
              <div className="node node-root">
                <span className="node-file">auth/token.ts</span>
                <span className="node-sym">validateToken()</span>
                <span className="node-tag tag-changed">changed</span>
              </div>
              <svg className="graph-edges" viewBox="0 0 360 220" aria-hidden="true">
                <path d="M180,52 C180,100 96,100 96,150" fill="none" stroke="var(--ink-dim)" strokeWidth="1.5" />
                <path d="M180,52 C180,100 270,100 270,150" fill="none" stroke="var(--ink-dim)" strokeWidth="1.5" />
                <path d="M180,52 C180,118 180,118 180,150" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 4" />
              </svg>
              <div className="node-row">
                <div className="node node-caller"><span className="node-file">api/login.ts</span><span className="node-sym">handleLogin()</span></div>
                <div className="node node-caller node-danger"><span className="node-file">api/refresh.ts</span><span className="node-sym">rotate()</span><span className="node-tag tag-api">crosses API</span></div>
                <div className="node node-caller"><span className="node-file">mw/guard.ts</span><span className="node-sym">requireAuth()</span></div>
              </div>
              <div className="graph-readout"><span className="b-mint">3 direct callers</span> · 2 files · 1 crosses an API boundary · 97% resolved</div>
            </div>
          </figure>
        </section>

        {/* local / open source */}
        <section id="local" className="run">
          <div className="section-head reveal">
            <p className="kicker">05 — Runs on your machine</p>
            <h2>Local by default. Open by license.</h2>
            <p className="sub">
              The whole reviewer is a deterministic Rust engine + a tiny MCP server. It runs where
              your code already lives — no server to trust, no diffs uploaded, nothing to pay for.
            </p>
          </div>

          <div className="stat-row reveal">
            <div className="stat"><b>MCP-native</b><span>your agent calls it — Claude Code, Codex, OpenCode</span></div>
            <div className="stat"><b>zero egress</b><span>no account, no token, no code leaves your laptop</span></div>
            <div className="stat"><b>BYO LLM</b><span>provider-neutral; optional, off by default</span></div>
            <div className="stat"><b>MIT</b><span>read it, fork it, self-host it — it&rsquo;s yours</span></div>
          </div>

          <div className="hero-actions reveal" style={{ justifyContent: "center", marginTop: "2rem" }}>
            <a className="btn btn-solid btn-lg" href="#install">Copy the install line</a>
            <a className="btn btn-ghost btn-lg" href={REPO} rel="noopener">Read the source →</a>
          </div>
        </section>

        {/* comparison */}
        <section className="compare reveal">
          <div className="section-head">
            <p className="kicker">06 — Why it&rsquo;s different</p>
            <h2>Built to be quiet.</h2>
          </div>
          <div className="table-wrap">
            <table className="cmp">
              <thead>
                <tr><th scope="col">Capability</th><th scope="col" className="us">S+</th><th scope="col">Typical AI reviewers</th></tr>
              </thead>
              <tbody>
                <tr><td>Reviews only newly-added lines</td><td className="us"><span className="yes">●</span></td><td><span className="no">○</span></td></tr>
                <tr><td>Every finding carries a deterministic anchor</td><td className="us"><span className="yes">●</span></td><td><span className="no">○</span></td></tr>
                <tr><td>Cross-file blast radius with confidence</td><td className="us"><span className="yes">●</span></td><td><span className="no">○</span></td></tr>
                <tr><td>Learns &amp; suppresses your dismissals</td><td className="us"><span className="yes">●</span></td><td><span className="meh">◐</span></td></tr>
                <tr><td>Runs fully locally, free, no key</td><td className="us"><span className="yes">●</span></td><td><span className="no">○</span></td></tr>
                <tr><td>Open source / bring your own LLM</td><td className="us"><span className="yes">●</span></td><td><span className="no">○</span></td></tr>
                <tr><td>Default posture</td><td className="us">quiet</td><td>loud</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* trust */}
        <section id="trust" className="trust reveal">
          <div className="trust-inner">
            <div className="section-head">
              <p className="kicker">07 — Trust</p>
              <h2>Your code is yours.</h2>
            </div>
            <ul className="trust-grid">
              <li><b>Nothing leaves your machine.</b> The engine runs on your checkout — no uploads.</li>
              <li><b>No telemetry.</b> No accounts, no tracking, no phone-home.</li>
              <li><b>Open source (MIT).</b> Audit every line; the engine is the source of truth.</li>
              <li><b>Bring your own LLM.</b> Provider-neutral, and off unless you opt in.</li>
              <li><b>Reproducible findings.</b> Every comment traces back to a concrete anchor.</li>
              <li><b>Learnings stay local.</b> Dismissals live in <code>.splus-cache</code>, in your repo.</li>
            </ul>
            <a className="btn btn-ghost" href={REPO} rel="noopener">Read the source →</a>
          </div>
        </section>

        {/* final cta */}
        <section className="final reveal">
          <h2 className="display">
            Stop reading noise.<br /><span className="hl-signal">Start at the signal.</span>
          </h2>
          <div className="hero-actions">
            <a className="btn btn-solid btn-lg" href="#install">Install — one line →</a>
            <a className="btn btn-ghost btn-lg" href={REPO} rel="noopener">View on GitHub</a>
          </div>
        </section>
      </main>

      {/* footer */}
      <footer className="foot">
        <div className="foot-brand">
          <span className="brand-word brand-word-lg">S<span className="brand-plus">+</span></span>
          <p>Precision-first code review.<br /><span className="foot-domain">splus.sh</span></p>
          <a className="kiwi-sign" href={ORG} rel="noopener" aria-label="A Kiwi Init project — kiwiinit.com">
            <pre className="kiwi-ascii" aria-hidden="true">{KIWI}</pre>
            <span className="kiwi-by">
              <span className="kiwi-tag">a kiwi init project</span>
              <span className="kiwi-url">kiwiinit.com →</span>
            </span>
          </a>
        </div>
        <nav className="foot-cols" aria-label="Footer">
          <div>
            <h4>Product</h4>
            <a href="#install">Install</a>
            <a href="#how">How it works</a>
            <a href="#local">Runs locally</a>
          </div>
          <div>
            <h4>Open source</h4>
            <a href={REPO} rel="noopener">GitHub</a>
            <a href={`${REPO}#readme`} rel="noopener">Docs</a>
            <a href={`${REPO}/releases`} rel="noopener">Releases</a>
          </div>
          <div>
            <h4>More</h4>
            <a href="#precision">Precision</a>
            <a href="#trust">Trust</a>
            <a href="https://splus.sh/install.sh">install.sh</a>
            <a href={ORG} rel="noopener">Kiwi Init ↗</a>
          </div>
        </nav>
        <p className="foot-legal">© <span data-year="">2026</span> S+ · maximize signal, floor the noise.</p>
      </footer>

      <Interactions />
    </>
  );
}
