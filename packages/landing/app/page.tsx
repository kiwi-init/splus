import Interactions from "@/components/Interactions";

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
        <nav className="nav-links" aria-label="Primary">
          <a href="#how">How it works</a>
          <a href="#precision">Precision</a>
          <a href="#run">Pricing</a>
          <a href="#trust">Trust</a>
          <a href="https://github.com/ojowwalker77" rel="noopener">GitHub</a>
        </nav>
        <div className="nav-cta">
          <a className="btn btn-ghost" href="https://dash.splus.sh">Dashboard</a>
          <a className="btn btn-solid" href="#install">Get started</a>
        </div>
      </header>

      <main id="top">
        {/* hero */}
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow"><span className="blip" />Precision-first code review</p>
            <h1 className="display">
              Only the comments<br />
              <span className="hl-signal">worth reading.</span>
            </h1>
            <p className="lede">
              Most AI reviewers bury real bugs under false positives. S+ is{" "}
              <strong>deterministic-first</strong>: it reviews only new lines, proves every
              finding, maps the blast radius across files, and learns the noise your team
              waves off. Maximum signal — noise on the floor.
            </p>
            <div className="hero-actions">
              <a className="btn btn-solid btn-lg" href="#install">Install free, run locally →</a>
              <a className="btn btn-ghost btn-lg" href="#github">Connect GitHub</a>
            </div>
            <p className="hero-foot">
              <span className="tick">no API key</span>
              <span className="tick">no code leaves your machine</span>
              <span className="tick">~60s to first review</span>
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
                "runs locally, free",
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
            <p className="kicker">01 — Start free</p>
            <h2>One line. Then ask your agent to review.</h2>
            <p className="sub">
              S+ ships as an MCP server your coding agent calls. The agent does the reasoning,
              S+ supplies the proof. Nothing is billed, nothing leaves your laptop.
            </p>
          </div>

          <div className="terminal">
            <div className="terminal-tabs" role="tablist">
              <button className="tab is-active" role="tab" data-tab="claude">Claude Code</button>
              <button className="tab" role="tab" data-tab="codex">Codex</button>
              <button className="tab" role="tab" data-tab="other">Other agents</button>
            </div>

            <div className="terminal-body">
              <div className="snippet is-active" data-pane="claude">
                <pre><code><span className="c-prompt">$</span>{" claude mcp add splus -- npx -y @splus/mcp"}</code></pre>
                <button className="copy" data-copy="claude mcp add splus -- npx -y @splus/mcp" aria-label="Copy command">copy</button>
              </div>
              <div className="snippet" data-pane="codex">
                <pre><code>{`# ~/.codex/config.toml
[mcp_servers.splus]
command = "npx"
args = ["-y", "@splus/mcp"]`}</code></pre>
                <button className="copy" data-copy={`[mcp_servers.splus]\ncommand = "npx"\nargs = ["-y", "@splus/mcp"]`} aria-label="Copy config">copy</button>
              </div>
              <div className="snippet" data-pane="other">
                <pre><code>{`# any MCP-capable client
command: npx
args:    ["-y", "@splus/mcp"]`}</code></pre>
                <button className="copy" data-copy={`command: npx\nargs: ["-y", "@splus/mcp"]`} aria-label="Copy config">copy</button>
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
              Illustrative. S+ publishes the real per-repo curve in your dashboard — precision is a
              number we stand behind, not a slogan.
            </figcaption>
          </figure>

          <div className="stat-row reveal">
            <div className="stat"><b>only new lines</b><span>legacy code is never re-litigated</span></div>
            <div className="stat"><b>0 inference</b><span>on the free local tier — your agent thinks</span></div>
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
              Most of the work happens with zero inference — fast, reproducible, and cheap. The LLM
              is downstream, and it only ever sees what survived.
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
              <p>Your repo&rsquo;s learned filter drops known noise. Only then does an LLM triage what&rsquo;s left — your agent locally, a frontier model in the cloud.</p>
            </li>
          </ol>
        </section>

        {/* moat */}
        <section className="moat">
          <div className="moat-copy reveal">
            <p className="kicker">04 — The moat</p>
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

        {/* two ways to run */}
        <section id="run" className="run">
          <div className="section-head reveal">
            <p className="kicker">05 — Two ways to run</p>
            <h2>Free on your machine. Paid on your PRs.</h2>
          </div>

          <div className="plans">
            <article className="plan reveal">
              <header className="plan-head">
                <h3>Local</h3>
                <span className="price">Free<span>forever</span></span>
              </header>
              <p className="plan-line">For the editor. Review before you commit.</p>
              <ul className="plan-feats">
                <li>MCP server your agent calls — Claude Code, Codex, more</li>
                <li>Full deterministic engine + blast radius</li>
                <li>Per-repo learning that quiets your noise</li>
                <li>No API key · no code leaves your machine</li>
                <li>Your agent is the judge — zero inference cost</li>
              </ul>
              <a className="btn btn-solid btn-block" href="#install">Copy the install line</a>
            </article>

            <article className="plan plan-pro reveal">
              <span className="plan-badge">Team</span>
              <header className="plan-head">
                <h3>GitHub bot</h3>
                <span className="price">Usage<span>per active author</span></span>
              </header>
              <p className="plan-line">For the PR. Review every change, automatically.</p>
              <ul className="plan-feats">
                <li>Auto-review every PR <em>or</em> on <code>@splus</code> mention</li>
                <li>Configure auto vs mention, severity gates, path filters</li>
                <li>Frontier-model judging — only what&rsquo;s worth your time</li>
                <li>Team learnings sync across the org</li>
                <li>Transparent, per-author usage in the dashboard</li>
              </ul>
              <a className="btn btn-ghost btn-block" id="github" href="https://dash.splus.sh">Connect GitHub →</a>
            </article>
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
                <tr><td>Bring your own LLM / provider-neutral</td><td className="us"><span className="yes">●</span></td><td><span className="no">○</span></td></tr>
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
              <li><b>No training on your code.</b> Ever. Not for us, not for a provider.</li>
              <li><b>Configurable retention.</b> Keep diffs for minutes, or not at all.</li>
              <li><b>Self-host the engine.</b> The deterministic core runs anywhere.</li>
              <li><b>Bring your own LLM.</b> Provider-neutral by design.</li>
              <li><b>Published precision.</b> We show our methodology and our numbers.</li>
              <li><b>SOC 2 path.</b> Built for the security review from day one.</li>
            </ul>
            <a className="btn btn-ghost" href="https://dash.splus.sh/trust">Read the Trust Center →</a>
          </div>
        </section>

        {/* final cta */}
        <section className="final reveal">
          <h2 className="display">
            Stop reading noise.<br /><span className="hl-signal">Start at the signal.</span>
          </h2>
          <div className="hero-actions">
            <a className="btn btn-solid btn-lg" href="#install">Install free →</a>
            <a className="btn btn-ghost btn-lg" href="https://dash.splus.sh">Connect GitHub</a>
          </div>
        </section>
      </main>

      {/* footer */}
      <footer className="foot">
        <div className="foot-brand">
          <span className="brand-word brand-word-lg">S<span className="brand-plus">+</span></span>
          <p>Precision-first code review.<br /><span className="foot-domain">splus.sh</span></p>
        </div>
        <nav className="foot-cols" aria-label="Footer">
          <div>
            <h4>Product</h4>
            <a href="#install">Local (free)</a>
            <a href="#github">GitHub bot</a>
            <a href="https://dash.splus.sh">Dashboard</a>
          </div>
          <div>
            <h4>Trust</h4>
            <a href="https://dash.splus.sh/trust">Trust Center</a>
            <a href="https://dash.splus.sh/trust">Precision method</a>
            <a href="https://dash.splus.sh/trust">Data &amp; retention</a>
          </div>
          <div>
            <h4>More</h4>
            <a href="https://github.com/ojowwalker77" rel="noopener">GitHub</a>
            <a href="#how">How it works</a>
            <a href="#precision">Precision</a>
          </div>
        </nav>
        <p className="foot-legal">© <span data-year="">2026</span> S+ · maximize signal, floor the noise.</p>
      </footer>

      <Interactions />
    </>
  );
}
