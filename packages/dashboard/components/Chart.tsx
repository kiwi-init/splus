import type { Week } from "@/lib/data";

/** The hero precision chart — signal (precision) rising over the noise floor. */
export default function Chart({ weeks }: { weeks: Week[] }) {
  if (!weeks.length) return <div className="empty">No review history yet.</div>;

  const W = 640, H = 210, L = 30, R = 10, T = 14, B = 26;
  const n = weeks.length;
  const x = (i: number) => L + (n <= 1 ? 0 : (i / (n - 1)) * (W - L - R));
  const y = (v: number) => T + (1 - v) * (H - T - B);

  const sig = weeks.map((w, i) => `${x(i).toFixed(1)},${y(w.precision).toFixed(1)}`).join(" ");
  const noise = weeks.map((w, i) => `${x(i).toFixed(1)},${y(w.fpRate).toFixed(1)}`).join(" ");
  const areaPts = weeks.map((w, i) => `${x(i).toFixed(1)},${y(w.precision).toFixed(1)}`).join(" L");
  const area = `M${x(0).toFixed(1)},${y(weeks[0].precision).toFixed(1)} L${areaPts} L${x(n - 1).toFixed(1)},${(H - B).toFixed(1)} L${L},${(H - B).toFixed(1)} Z`;
  const last = weeks[n - 1];
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="precision over time">
      <defs>
        <linearGradient id="sig" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--signal)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--signal)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((v) => (
        <g key={v}>
          <line className="gridline" x1={L} y1={y(v)} x2={W - R} y2={y(v)} />
          <text className="axis" x="0" y={y(v) + 3}>{v * 100}</text>
        </g>
      ))}
      <path className="areafill" d={area} />
      <polyline className="line noise" pathLength={1} points={noise} />
      <polyline className="line signal" pathLength={1} points={sig} />
      <circle className="dot" cx={x(n - 1)} cy={y(last.precision)} r={3.5} />
      <text className="axis" x={L} y={H - 6}>{weeks[0].weekStart}</text>
      <text className="axis" x={W - R} y={H - 6} textAnchor="end">{last.weekStart}</text>
    </svg>
  );
}
