import Link from "next/link";
import { listRepos, repoMode, repoPrecision, pct, ORG } from "@/lib/data";
import Stat from "@/components/Stat";

export default function Overview() {
  const repos = listRepos();
  const avg = repos.reduce((s, r) => s + repoPrecision(r).precision, 0) / Math.max(1, repos.length);
  const totalReviews = repos.reduce((s, r) => s + r.reviews, 0);

  return (
    <>
      <header className="topbar">
        <div className="crumb">OVERVIEW</div>
        <div className="topbar-right">
          <span className="pill pill-ok">● engine online</span>
          <span className="org">@{ORG}</span>
        </div>
      </header>

      <section className="content">
        <div className="grid g-3 mb">
          <Stat label="Org precision" num={pct(avg)} cls="signal" sub="acted-on ÷ posted, across repos" />
          <Stat label="Repos protected" num={String(repos.length)} sub="GitHub App installed" />
          <Stat label="Reviews / 4wk" num={String(totalReviews)} sub="deterministic + LLM" />
        </div>

        <div className="card">
          <div className="repos-head">
            <div className="eyebrow" style={{ margin: 0 }}>Repositories</div>
            <div className="label">precision · trend</div>
          </div>
          <div className="rows">
            {repos.map((r) => {
              const { precision, delta } = repoPrecision(r);
              const mode = repoMode(r.config);
              return (
                <Link
                  key={`${r.owner}/${r.name}`}
                  className="row"
                  style={{ gridTemplateColumns: "1.6fr 0.9fr 1fr 0.7fr" }}
                  href={`/repo/${r.owner}/${r.name}`}
                >
                  <div>
                    <div className="repo">
                      <span className="owner">{r.owner}/</span>
                      {r.name}
                    </div>
                    <div className="meta">
                      {mode === "auto" ? "auto-review" : mode === "mention" ? "@mention only" : "off"} · {r.reviews} reviews / 4wk
                    </div>
                  </div>
                  <div>
                    {r.config.llm && <span className="badge llm">LLM</span>} {r.sample && <span className="badge sample">sample</span>}
                  </div>
                  <div>
                    <div className="meta" style={{ marginBottom: 6 }}>precision {pct(precision)}</div>
                    <div className="pbar">
                      <i style={{ width: `${Math.round(precision * 100)}%` }} />
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span className={`delta ${delta >= 0 ? "up" : "down"}`}>
                      {delta >= 0 ? "▲" : "▼"} {pct(Math.abs(delta))}
                    </span>
                    <div className="meta">since wk1</div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </section>
    </>
  );
}
