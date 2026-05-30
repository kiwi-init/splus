"use client";

import { useState } from "react";
import type { RepoConfig } from "@/lib/data";

type BoolKey = "auto_review" | "mention_only" | "llm" | "thorough" | "show_nits";

const TOGGLES: { k: BoolKey; label: string; desc: string }[] = [
  { k: "auto_review", label: "Auto-review", desc: "Review automatically on PR open & every push." },
  { k: "mention_only", label: "@mention only", desc: "Never auto-review; wait for an @splus mention." },
  { k: "llm", label: "LLM triage", desc: "Judge / explain / suggest fixes on the deterministic candidates." },
  { k: "thorough", label: "Discovery pass", desc: "With LLM on, also hunt for logic/security bugs (frontier model)." },
  { k: "show_nits", label: "Post nits inline", desc: "Show nit-tier findings inline (default: collapsed to summary)." },
];

export default function ConfigForm({ config }: { config: RepoConfig }) {
  const [cfg, setCfg] = useState<RepoConfig>(config);
  const [saved, setSaved] = useState("");

  function set<K extends keyof RepoConfig>(k: K, v: RepoConfig[K]) {
    setCfg((c) => ({ ...c, [k]: v }));
  }

  return (
    <div>
      {TOGGLES.map((t) => (
        <div className="form-row" key={t.k}>
          <div>
            <div className="k">{t.label}</div>
            <div className="d">{t.desc}</div>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={cfg[t.k]} onChange={(e) => set(t.k, e.target.checked)} />
            <span className="track" />
            <span className="knob" />
          </label>
        </div>
      ))}

      <div className="form-row">
        <div>
          <div className="k">Fail the check at</div>
          <div className="d">Severity that turns the S+ check red. &lsquo;off&rsquo; = always advisory.</div>
        </div>
        <select value={cfg.fail_on} onChange={(e) => set("fail_on", e.target.value as RepoConfig["fail_on"])}>
          {["off", "low", "medium", "high", "critical"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div className="form-row">
        <div>
          <div className="k">Ignore paths</div>
          <div className="d">Comma-separated path prefixes to skip entirely.</div>
        </div>
        <input
          type="text"
          style={{ width: 220 }}
          value={cfg.ignore_paths.join(", ")}
          onChange={(e) => set("ignore_paths", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
        />
      </div>

      <div style={{ marginTop: 18, display: "flex", gap: 10, alignItems: "center" }}>
        <button
          className="btn"
          onClick={() => {
            setSaved("✓ written");
            setTimeout(() => setSaved(""), 1800);
          }}
        >
          Save config
        </button>
        <span className="saved">{saved}</span>
      </div>
    </div>
  );
}
