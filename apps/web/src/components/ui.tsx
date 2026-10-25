import type { ReactNode } from 'react';

export function Gauge({ value, label, size = 120 }: { value: number; label: string; size?: number }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const r = size / 2 - 10, c = 2 * Math.PI * r, color = v >= 80 ? 'var(--ok)' : v >= 60 ? 'var(--warn)' : 'var(--bad)';
  return (
    <figure className="gauge" aria-label={`${label}: ${v} out of 100`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth="10" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" className="gauge-num">{v}</text>
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

export function Bars({ rows }: { rows: { label: string; value: number; max?: number; note?: string }[] }) {
  return (
    <div className="bars">
      {rows.map((r) => {
        const pct = Math.max(0, Math.min(100, (r.value / (r.max ?? 100)) * 100));
        const color = pct >= 80 ? 'var(--ok)' : pct >= 60 ? 'var(--warn)' : 'var(--bad)';
        return (
          <div key={r.label} className="bar-row" title={r.note}>
            <span className="bar-label">{r.label}</span>
            <span className="bar-track"><span style={{ width: `${pct}%`, background: color }} /></span>
            <span className="bar-val">{Math.round(r.value)}</span>
          </div>
        );
      })}
    </div>
  );
}

const TONE: Record<string, string> = {
  succeeded: 'ok', ready: 'ok', partial: 'warn', almost_ready: 'warn', running: 'info', queued: 'muted',
  failed: 'bad', not_ready: 'bad', canceled: 'muted', skipped: 'muted', pending: 'muted',
};
export const Badge = ({ s }: { s: string }) => <span className={`badge ${TONE[s] ?? 'muted'}`}>{s.replace(/_/g, ' ')}</span>;

export const Card = ({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) => (
  <section className="card">{title && <header><h2>{title}</h2>{right}</header>}{children}</section>
);

export const Stat = ({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) => (
  <div className="stat"><span>{label}</span><strong>{value}</strong>{sub && <small>{sub}</small>}</div>
);
