import Link from "next/link";
import { ORG } from "@/lib/data";

const ITEMS = [
  {
    i: "⛨",
    h: "No training on your code",
    p: "Your code and diffs are never used to train any model — not ours, not a provider's. Inference is stateless: prompt in, review out.",
  },
  {
    i: "⏲",
    h: "Configurable retention",
    p: "Keep review context for minutes for debugging, or set zero-retention so nothing is persisted after a review completes. You choose, per org.",
  },
  {
    i: "▣",
    h: "Self-host the engine",
    p: "The deterministic core is a single binary with no network calls. Run it in your CI or air-gapped — the local MCP tier never leaves your machine.",
  },
  {
    i: "⟐",
    h: "Bring your own LLM",
    p: "Provider-neutral by design. Point S+ at your own key and model; the deterministic findings and learning loop work the same regardless of judge.",
  },
  {
    i: "∿",
    h: "Published precision",
    p: "We define precision as comments-acted-on ÷ comments-posted, measure it per repo, and show you the curve. A number we stand behind, not a slogan.",
  },
  {
    i: "✦",
    h: "SOC 2 path",
    p: "Architected for the security review from day one: least-privilege GitHub scopes, encrypted at rest and in transit, audit logging on the roadmap.",
  },
];

export default function Trust() {
  return (
    <>
      <header className="topbar">
        <div className="crumb">TRUST CENTER</div>
        <div className="topbar-right">
          <span className="pill pill-ok">● engine online</span>
          <span className="org">@{ORG}</span>
        </div>
      </header>

      <section className="content">
        <div className="trust-wrap">
          <Link href="/" className="back">← overview</Link>
          <h1 className="trust-h">Your code is yours.</h1>
          <p className="trust-lede">
            S+ is built precision-first and trust-first. The deterministic engine does most of the work with
            zero inference, and everything an LLM touches is governed by the guarantees below.
          </p>
          <div className="trust-list">
            {ITEMS.map((it) => (
              <div className="trust-item" key={it.h}>
                <h3><span className="i">{it.i}</span>{it.h}</h3>
                <p>{it.p}</p>
              </div>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 28 }}>
            Questions for a security review? <a className="tlink" href="https://splus.sh">splus.sh</a> ·{" "}
            <a className="tlink" href="https://github.com/ojowwalker77">github.com/ojowwalker77</a>
          </p>
        </div>
      </section>
    </>
  );
}
