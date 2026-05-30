"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "▚ Overview", match: (p: string) => p === "/" || p.startsWith("/repo") },
  { href: "/billing", label: "≣ Usage & billing", match: (p: string) => p.startsWith("/billing") },
  { href: "/trust", label: "⛨ Trust Center", match: (p: string) => p.startsWith("/trust") },
];

// A static "signal settling over noise" waveform for the rail foot.
const WAVE = "0,20 8,8 16,23 24,7 32,19 40,9 48,15 56,10 64,13 72,9 80,11 88,9.5 96,10.5 104,9.5 112,10 120,9.5";

export default function Rail() {
  const path = usePathname();
  return (
    <aside className="rail">
      <div>
        <div className="brand">
          <svg className="brand-mark" width="22" height="22" viewBox="0 0 26 26" aria-hidden="true">
            <path d="M2 13 H7 L9.5 6 L13.5 20 L16.5 13 H24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="mark">S<span className="plus">+</span></span>
          <span className="cursor" />
        </div>
        <div className="brand-sub">REVIEW CONSOLE</div>
        <nav>
          {ITEMS.map((it) => (
            <Link key={it.href} href={it.href} className={`nav-item${it.match(path) ? " active" : ""}`}>
              {it.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="rail-foot">
        <svg className="mini-wave" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={WAVE} fill="none" stroke="#31e6a0" strokeWidth="1.4" strokeLinejoin="round" opacity="0.8" />
        </svg>
        <div className="rail-meta">DETERMINISTIC ENGINE · v0.1.0</div>
        <div className="rail-meta dim">signal ÷ noise</div>
      </div>
    </aside>
  );
}
