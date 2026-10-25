import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProject, listRuns } from '@stora-sh/db';
import { requireSession } from '@/lib/auth';
import { getDb } from '@/lib/server';
import { Shell } from '@/components/Shell';
import { Badge, Card } from '@/components/ui';
import { removeProject, startRun } from '@/lib/actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // server action 'Run agents' drains the queue after responding
const GOALS = [['full_audit', 'Full launch audit'], ['compliance', 'Compliance only'], ['aso', 'ASO keywords'], ['listing', 'Store listing copy']] as const;

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await requireSession();
  const db = await getDb();
  const p = await getProject(db, s.org.id, id).catch(() => null);
  if (!p) notFound();
  const runs = await listRuns(db, s.org.id, { projectId: id, limit: 20 }).then((rs) => rs.map((x) => x.run));
  return (
    <Shell s={s}>
      <h1>{p.name}</h1>
      <p className="muted">{p.repoUrl} · {p.branch} · {p.platform}</p>
      <Card title="Start a run">
        <form action={startRun} className="row">
          <input type="hidden" name="projectId" value={p.id} />
          <select name="goal" defaultValue="full_audit">{GOALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <button>Run agents</button>
        </form>
      </Card>
      <Card title="History">
        <table><thead><tr><th>Goal</th><th>Status</th><th>Readiness</th><th>When</th></tr></thead><tbody>
          {runs.map((r) => <tr key={r.id}><td><Link href={`/runs/${r.id}`}>{r.goal}</Link></td><td><Badge s={r.status} /></td><td>{(r.result as { readinessScore?: number } | null)?.readinessScore ?? '—'}</td><td>{r.createdAt.toLocaleString()}</td></tr>)}
          {runs.length === 0 && <tr><td colSpan={4} className="muted">No runs yet.</td></tr>}
        </tbody></table>
      </Card>
      <form action={removeProject}><input type="hidden" name="id" value={p.id} /><button className="danger">Delete project</button></form>
    </Shell>
  );
}
