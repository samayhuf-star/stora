import Link from 'next/link';
import { listProjects, listRuns, orgOverview } from '@stora-sh/db';
import { requireSession } from '@/lib/auth';
import { getDb } from '@/lib/server';
import { Shell } from '@/components/Shell';
import { Badge, Bars, Card, Gauge, Stat } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const s = await requireSession();
  const db = await getDb();
  const [ov, projs, runs] = await Promise.all([orgOverview(db, s.org.id), listProjects(db, s.org.id), listRuns(db, s.org.id, { limit: 15 }).then((rs) => rs.map((x) => ({ ...x.run, projectName: x.projectName })))]);
  if (!ov) return null;
  const scoreOf = (r: { result: unknown }) => (r.result as { readinessScore?: number } | null)?.readinessScore;
  const latest = runs.find((r) => scoreOf(r) != null);
  const names = new Map(projs.map((p) => [p.id, p.name]));
  const statusRows = Object.entries(ov.runsByStatus).map(([label, value]) => ({ label, value: value ?? 0, max: Math.max(1, ...Object.values(ov.runsByStatus).map((n) => n ?? 0)) }));
  return (
    <Shell s={s}>
      <h1>Dashboard</h1>
      <div className="grid stats">
        <Stat label="Projects" value={`${ov.projects} / ${ov.limits.projects}`} />
        <Stat label="Runs this month" value={`${ov.runsThisMonth} / ${ov.limits.runsPerMonth}`} sub={`${ov.limits.label} plan`} />
        <Stat label="LLM tokens this month" value={ov.llmTokensThisMonth.toLocaleString()} />
      </div>
      <div className="grid two">
        <Card title="Latest launch readiness">
          {latest ? <><Gauge value={scoreOf(latest)!} label={names.get(latest.projectId) ?? 'Project'} size={150} /><Link href={`/runs/${latest.id}`}>Open report →</Link></> : <p className="muted">No finished runs yet. Create a project and start a run.</p>}
        </Card>
        <Card title="Runs by status">{statusRows.length ? <Bars rows={statusRows} /> : <p className="muted">Nothing yet.</p>}</Card>
      </div>
      <Card title="Projects" right={<Link href="/projects/new">+ New project</Link>}>
        <table><thead><tr><th>Name</th><th>Repository</th><th>Platform</th></tr></thead><tbody>
          {projs.map((p) => <tr key={p.id}><td><Link href={`/projects/${p.id}`}>{p.name}</Link></td><td>{p.repoUrl}</td><td>{p.platform}</td></tr>)}
          {projs.length === 0 && <tr><td colSpan={3} className="muted">No projects yet.</td></tr>}
        </tbody></table>
      </Card>
      <Card title="Recent runs">
        <table><thead><tr><th>Project</th><th>Goal</th><th>Status</th><th>Readiness</th><th>Started</th></tr></thead><tbody>
          {runs.map((r) => <tr key={r.id}><td><Link href={`/runs/${r.id}`}>{names.get(r.projectId) ?? '—'}</Link></td><td>{r.goal}</td><td><Badge s={r.status} /></td><td>{scoreOf(r) ?? '—'}</td><td>{r.createdAt.toLocaleString()}</td></tr>)}
          {runs.length === 0 && <tr><td colSpan={5} className="muted">No runs yet.</td></tr>}
        </tbody></table>
      </Card>
    </Shell>
  );
}
