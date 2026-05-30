export default function Stat({
  label,
  num,
  cls = "",
  sub,
}: {
  label: string;
  num: string;
  cls?: string;
  sub: string;
}) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className={`num ${cls}`}>{num}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}
