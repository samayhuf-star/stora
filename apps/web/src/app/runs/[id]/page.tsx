import { notFound } from 'next/navigation';
import { getRunDetail, listEvents } from '@stora-sh/db';
import { requireSession } from '@/lib/auth';
import { getDb } from '@/lib/server';
import { Shell } from '@/components/Shell';
import { LiveRun } from '@/components/LiveRun';
import { Badge, Bars, Card, Gauge } from '@/components/ui';
import { cancelRun } from '@/lib/actions';

export const dynamic = 'force-dynamic';

interface Report {
  verdict: 'ready' | 'almost_ready' | 'not_ready'; readinessScore: number; narrative: string; blockers: string[]; crossChecks: string[];
  breakdown: { area: string; score: number; weight: number; note: string }[];
  checklist: { priority: number; title: string; detail: string; owner: string; severity: string }[];
  planner?: string; rationale?: string; tokens?: { in?: number; out?: number };
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await requireSession();
  const db = await getDb();
  const d = await getRunDetail(db, s.org.id, id).catch(() => null);
  if (!d) notFound();
  const events = (await listEvents(db, id, 0, 300)).map((e) => ({ id: e.id, agent: e.agent, level: e.level, message: e.message, createdAt: e.createdAt.toISOString() }));
  const r = d.run.result as Report | null;
  const live = d.run.status === 'queued' || d.run.status === 'running';
  const steps = d.steps.map((x) => ({ agent: x.agent, title: x.title, status: x.status, summary: x.summary, error: x.error, mode: x.mode }));
  return (
    <Shell s={s}>
      <h1>{d.project.name} <Badge s={d.run.status} /></h1>
      <p className="muted">Goal: {d.run.goal}{r?.planner && ` · planner: ${r.planner}`}{r?.rationale && ` · ${r.rationale}`}</p>
      {live && <form action={cancelRun}><input type="hidden" name="id" value={id} /><button className="danger">Cancel run</button></form>}
      {d.run.error && <p className="err">{d.run.error}</p>}
      {r && (
        <>
          <div className="grid two">
            <Card title="Launch readiness"><Gauge value={r.readinessScore} label={r.verdict.replace(/_/g, ' ')} size={160} /><p>{r.narrative}</p></Card>
            <Card title="Score breakdown"><Bars rows={r.breakdown.map((b) => ({ label: `${b.area.replace(/_/g, ' ')} (${Math.round(b.weight)}%)`, value: b.score, note: b.note }))} />
              <table><tbody>{r.breakdown.map((b) => <tr key={b.area}><td>{b.area.replace(/_/g, ' ')}</td><td>{b.note}</td></tr>)}</tbody></table></Card>
          </div>
          {r.blockers.length > 0 && <Card title="Blockers"><ul>{r.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></Card>}
          <Card title="Action checklist">
            <table><thead><tr><th>#</th><th>Action</th><th>Severity</th><th>Owner</th></tr></thead><tbody>
              {r.checklist.map((c, i) => <tr key={i}><td>{c.priority}</td><td><strong>{c.title}</strong><br /><small>{c.detail}</small></td><td><Badge s={c.severity === 'blocker' ? 'failed' : c.severity === 'important' ? 'partial' : 'queued'} /> {c.severity.replace(/_/g, ' ')}</td><td>{c.owner}</td></tr>)}
            </tbody></table>
          </Card>
          {r.crossChecks.length > 0 && <Card title="Cross-agent checks"><ul>{r.crossChecks.map((c, i) => <li key={i}>{c}</li>)}</ul></Card>}
        </>
      )}
      <Card title="Agent activity"><LiveRun runId={id} initial={{ status: d.run.status, steps, events }} /></Card>
      {d.artifacts.length > 0 && (
        <Card title="Artifacts"><table><tbody>{d.artifacts.map((a) => <tr key={a.id}><td>{a.name}</td><td>{a.kind}</td><td><a href={`/api/artifacts/${a.id}`}>Download</a></td></tr>)}</tbody></table></Card>
      )}
    </Shell>
  );
}
