import Link from "next/link";
import { billingSummary, ORG } from "@/lib/data";
import Stat from "@/components/Stat";

export default function Billing() {
  const b = billingSummary();

  return (
    <>
      <header className="topbar">
        <div className="crumb">USAGE &amp; BILLING</div>
        <div className="topbar-right">
          <span className="pill pill-ok">● engine online</span>
          <span className="org">@{ORG}</span>
        </div>
      </header>

      <section className="content">
        <div className="grid g-3 mb">
          <Stat label="Plan" num={b.plan} sub="billed per active PR author" />
          <Stat label="This month" num={`$${b.monthly}`} cls="signal" sub={`${b.billedAuthors} billed of ${b.authors.length} contributors`} />
          <Stat label="Reviews" num={String(b.totalReviews)} sub={`${b.includedReviewsPerAuthor} included / author`} />
        </div>

        <div className="card">
          <div className="eyebrow">Contributors · you only pay for authors whose PRs S+ reviewed</div>
          <div className="rows">
            {b.authors.map((a) => {
              const billed = a.reviews > 0;
              return (
                <div className="learn-row" key={a.login}>
                  <div>
                    <div className="code">
                      {a.login} {!billed && <span className="badge" style={{ marginLeft: 6 }}>not billed</span>}
                    </div>
                    <div className="why">{a.reviews} reviews this month</div>
                  </div>
                  <div className="meta">{billed ? `$${b.pricePerAuthor}/mo` : "$0"}</div>
                </div>
              );
            })}
          </div>
          <div className="hint" style={{ marginTop: 18 }}>
            Transparent meter — no surprise usage bills. Reviewers, bots, and idle seats are never charged.{" "}
            <Link className="tlink" href="/trust">Trust Center →</Link>
          </div>
        </div>
      </section>
    </>
  );
}
