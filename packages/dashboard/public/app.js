// Splus Console — zero-build SPA. Hash router, fetch, hand-rolled SVG charts.
const app = document.getElementById("app");
const crumb = document.getElementById("crumb");
const orgEl = document.getElementById("org");

const api = (p, opts) => fetch(p, opts).then((r) => r.json());
const pct = (v) => `${Math.round(v * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// --- mini waveform in the rail (signal settling over noise) ---
(function miniWave() {
  const svg = document.querySelector(".mini-wave");
  if (!svg) return;
  const n = 60, pts = [];
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 120;
    const settle = Math.pow(i / n, 1.5);
    const noise = (1 - settle) * (Math.sin(i * 2.3) * 0.5 + Math.sin(i * 0.7) * 0.5);
    const y = 14 - (settle * 8) + noise * 7;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  svg.innerHTML = `<polyline points="${pts.join(" ")}" fill="none" stroke="#46e6a8" stroke-width="1.4" stroke-linejoin="round" opacity="0.8"/>`;
})();

// --- the hero precision chart ---
function chartSVG(weeks) {
  const W = 640, H = 210, L = 30, R = 10, T = 14, B = 26;
  const n = weeks.length;
  const x = (i) => L + (n <= 1 ? 0 : (i / (n - 1)) * (W - L - R));
  const y = (v) => T + (1 - v) * (H - T - B);
  const sig = weeks.map((w, i) => `${x(i).toFixed(1)},${y(w.precision).toFixed(1)}`);
  const noise = weeks.map((w, i) => `${x(i).toFixed(1)},${y(w.fpRate).toFixed(1)}`);
  const area = `M${x(0).toFixed(1)},${y(weeks[0].precision).toFixed(1)} L${sig.join(" L")} L${x(n - 1).toFixed(1)},${(H - B).toFixed(1)} L${L},${(H - B).toFixed(1)} Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((v) => `<line class="gridline" x1="${L}" y1="${y(v).toFixed(1)}" x2="${W - R}" y2="${y(v).toFixed(1)}"/><text class="axis" x="0" y="${(y(v) + 3).toFixed(1)}">${v * 100}</text>`)
    .join("");
  const last = weeks[n - 1];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="precision over time">
    <defs><linearGradient id="sig" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#46e6a8" stop-opacity="0.28"/><stop offset="1" stop-color="#46e6a8" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path class="areafill" d="${area}"/>
    <polyline class="line noise" pathLength="1" points="${noise.join(" ")}"/>
    <polyline class="line signal" pathLength="1" points="${sig.join(" ")}"/>
    <circle class="dot" cx="${x(n - 1).toFixed(1)}" cy="${y(last.precision).toFixed(1)}" r="3.5"/>
    <text class="axis" x="${L}" y="${H - 6}">${esc(weeks[0].weekStart)}</text>
    <text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(last.weekStart)}</text>
  </svg>`;
}

// --- routes ---
async function overview() {
  crumb.textContent = "OVERVIEW";
  setActive("#/");
  const data = await api("/api/overview");
  orgEl.textContent = "@" + data.org;
  const rows = data.repos
    .map((r) => {
      const d = r.precisionDelta;
      const arrow = d >= 0 ? `<span class="delta up">▲ ${pct(Math.abs(d))}</span>` : `<span class="delta down">▼ ${pct(Math.abs(d))}</span>`;
      return `<a class="row" style="grid-template-columns: 1.6fr 0.9fr 1fr 0.7fr" href="#/repo/${r.owner}/${r.name}">
        <div><div class="repo"><span class="owner">${esc(r.owner)}/</span>${esc(r.name)}</div>
          <div class="meta">${r.mode === "auto" ? "auto-review" : r.mode === "mention" ? "@mention only" : "off"} · ${r.reviews} reviews / 4wk</div></div>
        <div>${r.llm ? '<span class="badge llm">LLM</span> ' : ""}${r.sample ? '<span class="badge sample">sample</span>' : ""}</div>
        <div><div class="meta" style="margin-bottom:6px">precision ${pct(r.precision)}</div><div class="pbar"><i style="width:${Math.round(r.precision * 100)}%"></i></div></div>
        <div style="text-align:right">${arrow}<div class="meta">since wk1</div></div>
      </a>`;
    })
    .join("");
  const avg = data.repos.reduce((s, r) => s + r.precision, 0) / Math.max(1, data.repos.length);
  app.innerHTML = `
    <div class="grid g-3 mb">
      ${stat("Org precision", pct(avg), "signal", "acted-on ÷ posted, across repos")}
      ${stat("Repos protected", String(data.repos.length), "", "GitHub App installed")}
      ${stat("Reviews / 4wk", String(data.repos.reduce((s, r) => s + r.reviews, 0)), "", "deterministic + LLM")}
    </div>
    <div class="card">
      <div class="repos-head"><div class="eyebrow" style="margin:0">Repositories</div><div class="label">precision · trend</div></div>
      <div class="rows">${rows}</div>
    </div>`;
}

async function repo(owner, name) {
  crumb.textContent = `${owner}/${name}`.toUpperCase();
  setActive("#/");
  const [cfg, metrics, learnings] = await Promise.all([
    api(`/api/repos/${owner}/${name}/config`),
    api(`/api/repos/${owner}/${name}/metrics`),
    api(`/api/repos/${owner}/${name}/learnings`),
  ]);
  const w = metrics.weeks;
  const last = w[w.length - 1] || { precision: 0, fpRate: 0 };
  const first = w[0] || { precision: 0, fpRate: 0 };
  app.innerHTML = `
    <a href="#/" class="label" style="text-decoration:none;display:inline-block;margin-bottom:18px">← overview</a>
    <div class="card hero">
      <div class="hero-head">
        <div>
          <div class="eyebrow" style="margin-bottom:10px">Precision · the falling false-positive rate</div>
          <div class="big">${pct(last.precision)}</div>
          <div class="legend">
            <span><i class="swatch sw-signal"></i> signal — comments acted on</span>
            <span><i class="swatch sw-noise"></i> noise floor — dismissed</span>
          </div>
        </div>
        <div style="text-align:right">
          ${metrics.sample ? '<span class="badge sample">sample data</span>' : '<span class="badge">live</span>'}
          <div class="stat" style="margin-top:14px"><div class="sub">${pct(first.precision)} → ${pct(last.precision)}</div>
          <div class="delta up" style="font-size:13px;margin-top:2px">▲ ${pct(last.precision - first.precision)} since week 1</div></div>
        </div>
      </div>
      ${w.length ? chartSVG(w) : '<div class="empty">No review history yet.</div>'}
    </div>

    <div class="grid g-2 mb" style="margin-top:16px">
      <div class="card">
        <div class="eyebrow">Behavior · .splus.yml</div>
        <div id="form"></div>
        <div style="margin-top:18px;display:flex;gap:10px;align-items:center">
          <button class="btn" id="save">Save config</button>
          <span class="meta" id="saved"></span>
        </div>
      </div>
      <div class="card">
        <div class="eyebrow">Learnings · per-repo noise filter</div>
        <div class="hint mb">Dismiss once, and the whole class goes quiet — exact, rule, and semantic.</div>
        <div id="learn"></div>
      </div>
    </div>`;

  renderForm(owner, name, cfg);
  renderLearnings(owner, name, learnings);
}

function renderForm(owner, name, cfg) {
  const f = document.getElementById("form");
  const toggle = (k, label, desc) =>
    `<div class="form-row"><div><div class="k">${label}</div><div class="d">${desc}</div></div>
     <label class="toggle"><input type="checkbox" data-k="${k}" ${cfg[k] ? "checked" : ""}/><span class="track"></span><span class="knob"></span></label></div>`;
  f.innerHTML =
    toggle("auto_review", "Auto-review", "Review automatically on PR open & every push.") +
    toggle("mention_only", "@mention only", "Never auto-review; wait for an @splus mention.") +
    toggle("llm", "LLM triage", "Judge / explain / suggest fixes on the deterministic candidates.") +
    toggle("thorough", "Discovery pass", "With LLM on, also hunt for logic/security bugs (frontier model).") +
    toggle("show_nits", "Post nits inline", "Show nit-tier findings inline (default: collapsed to summary).") +
    `<div class="form-row"><div><div class="k">Fail the check at</div><div class="d">Severity that turns the Splus check red. 'off' = always advisory.</div></div>
       <select data-k="fail_on">${["off", "low", "medium", "high", "critical"].map((s) => `<option ${cfg.fail_on === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>` +
    `<div class="form-row"><div><div class="k">Ignore paths</div><div class="d">Comma-separated path prefixes to skip entirely.</div></div>
       <input type="text" data-k="ignore_paths" value="${esc((cfg.ignore_paths || []).join(", "))}" style="width:220px"/></div>`;

  document.getElementById("save").onclick = async () => {
    const body = {};
    f.querySelectorAll("[data-k]").forEach((el) => {
      const k = el.dataset.k;
      if (el.type === "checkbox") body[k] = el.checked;
      else if (k === "ignore_paths") body[k] = el.value.split(",").map((s) => s.trim()).filter(Boolean);
      else body[k] = el.value;
    });
    await api(`/api/repos/${owner}/${name}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const s = document.getElementById("saved");
    s.textContent = "✓ written";
    s.style.color = "var(--signal)";
    setTimeout(() => (s.textContent = ""), 1800);
  };
}

function renderLearnings(owner, name, entries) {
  const box = document.getElementById("learn");
  if (!entries.length) {
    box.innerHTML = `<div class="empty">No learnings yet — Splus is at full sensitivity.</div>`;
    return;
  }
  box.innerHTML = entries
    .map((e) => {
      const head = e.scope === "rule" ? esc(e.rule_id) : `${esc(e.fingerprint)} <span style="color:var(--muted)">(${esc(e.rule_id)})</span>`;
      const key = e.scope === "rule" ? e.rule_id : e.fingerprint;
      return `<div class="learn-row">
        <div><div class="code"><span class="kind ${e.scope}">${e.scope}</span> ${head}</div>
          <div class="why">${esc(e.signal)} · ${esc(e.at.slice(0, 10))}</div></div>
        <button class="btn ghost tiny" data-scope="${e.scope}" data-key="${esc(key)}">restore</button></div>`;
    })
    .join("");
  box.querySelectorAll("button[data-key]").forEach((b) => {
    b.onclick = async () => {
      await fetch(`/api/repos/${owner}/${name}/learnings?scope=${b.dataset.scope}&key=${encodeURIComponent(b.dataset.key)}`, { method: "DELETE" });
      const fresh = await api(`/api/repos/${owner}/${name}/learnings`);
      renderLearnings(owner, name, fresh);
    };
  });
}

async function billing() {
  crumb.textContent = "USAGE & BILLING";
  setActive("#/billing");
  const b = await api("/api/billing");
  const rows = b.authors
    .map((a) => {
      const billed = a.reviews > 0;
      return `<div class="learn-row">
        <div><div class="code">${esc(a.login)} ${billed ? "" : '<span class="badge" style="margin-left:6px">not billed</span>'}</div>
          <div class="why">${a.reviews} reviews this month</div></div>
        <div class="meta">${billed ? "$" + b.pricePerAuthor + "/mo" : "$0"}</div></div>`;
    })
    .join("");
  app.innerHTML = `
    <div class="grid g-3 mb">
      ${stat("Plan", b.plan, "", "billed per active PR author")}
      ${stat("This month", "$" + b.monthly, "signal", b.billedAuthors + " billed of " + b.authors.length + " contributors")}
      ${stat("Reviews", String(b.totalReviews), "", b.includedReviewsPerAuthor + " included / author")}
    </div>
    <div class="card">
      <div class="eyebrow">Contributors · you only pay for authors whose PRs Splus reviewed</div>
      <div class="rows">${rows}</div>
      <div class="hint" style="margin-top:18px">Transparent meter — no surprise usage bills. Reviewers, bots, and idle seats are never charged. <a class="tlink" href="/trust">Trust Center →</a></div>
    </div>`;
}

// --- helpers ---
function stat(label, num, cls, sub) {
  return `<div class="card stat"><div class="label">${label}</div><div class="num ${cls}">${num}</div><div class="sub">${sub}</div></div>`;
}
function setActive(route) {
  document.querySelectorAll(".nav-item").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
}

function router() {
  const h = location.hash || "#/";
  const m = h.match(/^#\/repo\/([^/]+)\/([^/]+)/);
  if (m) return repo(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  if (h.startsWith("#/billing")) return billing();
  return overview();
}
window.addEventListener("hashchange", router);
router();
