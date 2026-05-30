"use client";

import { useState } from "react";
import type { Learning } from "@/lib/data";

export default function Learnings({ learnings }: { learnings: Learning[] }) {
  const [items, setItems] = useState<Learning[]>(learnings);

  if (!items.length) {
    return <div className="empty">No learnings yet — S+ is at full sensitivity.</div>;
  }

  return (
    <div>
      {items.map((e, i) => {
        const key = e.scope === "rule" ? e.rule_id : e.fingerprint;
        return (
          <div className="learn-row" key={`${e.scope}-${key}-${i}`}>
            <div>
              <div className="code">
                <span className={`kind ${e.scope}`}>{e.scope}</span>{" "}
                {e.scope === "rule" ? (
                  e.rule_id
                ) : (
                  <>
                    {e.fingerprint} <span style={{ color: "var(--muted)" }}>({e.rule_id})</span>
                  </>
                )}
              </div>
              <div className="why">
                {e.signal} · {e.at.slice(0, 10)}
              </div>
            </div>
            <button className="btn ghost tiny" onClick={() => setItems((list) => list.filter((_, j) => j !== i))}>
              restore
            </button>
          </div>
        );
      })}
    </div>
  );
}
