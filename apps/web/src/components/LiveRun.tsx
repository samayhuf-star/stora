'use client';
import { useEffect, useRef, useState } from 'react';
import { Badge } from './ui';

interface Ev { id: number; agent: string | null; level: string; message: string; createdAt: string }
interface Step { agent: string; title: string; status: string; summary: string | null; error: string | null; mode: string | null }
interface Snap { status: string; steps: Step[]; events: Ev[] }
const TERMINAL = ['succeeded', 'partial', 'failed', 'canceled'];

export function LiveRun({ runId, initial }: { runId: string; initial: Snap }) {
  const [snap, setSnap] = useState<Snap>(initial);
  const last = useRef(initial.events.at(-1)?.id ?? 0);
  const done = useRef(TERMINAL.includes(initial.status));

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/runs/${runId}?after=${last.current}`, { cache: 'no-store' });
        if (r.ok) {
          const d = await r.json();
          const evs: Ev[] = d.events ?? [];
          if (evs.length) last.current = evs[evs.length - 1].id;
          setSnap((p) => ({ status: d.run.status, steps: d.steps, events: [...p.events, ...evs].slice(-300) }));
          if (TERMINAL.includes(d.run.status)) {
            if (!done.current) { done.current = true; window.location.reload(); } // load the final report
            return;
          }
        }
      } catch { /* retry */ }
      if (!stop) setTimeout(tick, 1500);
    };
    if (!done.current) tick();
    return () => { stop = true; };
  }, [runId]);

  return (
    <>
      <div className="steps">
        {snap.steps.map((s) => (
          <div key={s.agent} className={`step ${s.status}`}>
            <div><strong>{s.title}</strong> <Badge s={s.status} /> {s.mode && <small className="muted">{s.mode}</small>}</div>
            <small>{s.error ?? s.summary ?? ''}</small>
          </div>
        ))}
        {snap.steps.length === 0 && <p className="muted">Supervisor is planning…</p>}
      </div>
      <pre className="log" aria-label="Run log">
        {snap.events.map((e) => `${new Date(e.createdAt).toLocaleTimeString()} [${e.agent ?? 'run'}] ${e.level === 'info' ? '' : e.level.toUpperCase() + ' '}${e.message}`).join('\n')}
      </pre>
    </>
  );
}
