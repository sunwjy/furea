// Tiny SVG helpers shared by variants (a chart is not a layout, so sharing is fine).
export function Bars({ series, height = 120 }: { series: { t: string; clicks: number }[]; height?: number }) {
  const max = Math.max(1, ...series.map((s) => s.clicks));
  const w = 100 / series.length;
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="chart-bars" style={{ height }}>
      {series.map((s, i) => {
        const h = (s.clicks / max) * (height - 4);
        return <rect key={s.t} x={i * w + w * 0.1} y={height - h} width={w * 0.8} height={h}><title>{`${s.t.slice(0, 13)} · ${s.clicks}`}</title></rect>;
      })}
    </svg>
  );
}
export function Sparkline({ series }: { series: { clicks: number }[] }) {
  const max = Math.max(1, ...series.map((s) => s.clicks));
  const pts = series.map((s, i) => `${(i / (series.length - 1)) * 100},${30 - (s.clicks / max) * 28}`).join(' ');
  return <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="sparkline"><polyline points={pts} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
}
export function TopList({ title, rows, total }: { title: string; rows: { key: string; clicks: number }[]; total: number }) {
  return (
    <div className="toplist">
      <h4>{title}</h4>
      {rows.slice(0, 10).map((r) => (
        <div key={r.key} className="toplist-row">
          <span className="toplist-key">{r.key}</span>
          <span className="toplist-bar"><i style={{ width: `${(r.clicks / Math.max(1, total)) * 100}%` }} /></span>
          <span className="toplist-num">{r.clicks}</span>
        </div>
      ))}
    </div>
  );
}
