import Link from "next/link";
import { notFound } from "next/navigation";
import { listRepos, getRepo, pct } from "@/lib/data";
import Chart from "@/components/Chart";
import ConfigForm from "@/components/ConfigForm";
import Learnings from "@/components/Learnings";

export function generateStaticParams() {
  return listRepos().map((r) => ({ owner: r.owner, name: r.name }));
}

export default async function RepoPage({ params }: { params: Promise<{ owner: string; name: string }> }) {
  const { owner, name } = await params;
  const r = getRepo(owner, name);
  if (!r) notFound();

  const first = r.weeks[0];
  const last = r.weeks[r.weeks.length - 1];

  return (
    <>
      <header className="topbar">
        <div className="crumb">{`${r.owner}/${r.name}`.toUpperCase()}</div>
        <div className="topbar-right">
          <span className="pill pill-ok">● engine online</span>
          <span className="org">@{r.owner}</span>
        </div>
      </header>

      <section className="content">
        <Link href="/" className="back">← overview</Link>

        <div className="card hero">
          <div className="hero-head">
            <div>
              <div className="eyebrow" style={{ marginBottom: 10 }}>Precision · the falling false-positive rate</div>
              <div className="big">{pct(last.precision)}</div>
              <div className="legend">
                <span><i className="swatch sw-signal" /> signal — comments acted on</span>
                <span><i className="swatch sw-noise" /> noise floor — dismissed</span>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              {r.sample ? <span className="badge sample">sample data</span> : <span className="badge">live</span>}
              <div style={{ marginTop: 14 }}>
                <div className="meta">{pct(first.precision)} → {pct(last.precision)}</div>
                <div className="delta up" style={{ fontSize: 13, marginTop: 2 }}>▲ {pct(last.precision - first.precision)} since week 1</div>
              </div>
            </div>
          </div>
          <Chart weeks={r.weeks} />
        </div>

        <div className="grid g-2 mb" style={{ marginTop: 16 }}>
          <div className="card">
            <div className="eyebrow">Behavior · .splus.yml</div>
            <ConfigForm config={r.config} />
          </div>
          <div className="card">
            <div className="eyebrow">Learnings · per-repo noise filter</div>
            <div className="hint mb">Dismiss once, and the whole class goes quiet — exact, rule, and semantic.</div>
            <Learnings learnings={r.learnings} />
          </div>
        </div>
      </section>
    </>
  );
}
