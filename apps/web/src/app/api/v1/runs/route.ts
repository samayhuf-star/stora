import { NextResponse, after } from 'next/server';
import { LimitError, enqueueRun, getProject, listRuns, type RunGoal } from '@stora-sh/db';
import { authApi } from '@/lib/auth';
import { drainQueue, getDb } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const GOALS: RunGoal[] = ['full_audit', 'compliance', 'aso', 'listing'];

export async function GET(req: Request) {
  const a = await authApi(req);
  if (!a) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const rows = await listRuns(await getDb(), a.orgId, { limit: 50 });
  return NextResponse.json({ runs: rows.map(({ run: r }) => ({ id: r.id, projectId: r.projectId, goal: r.goal, status: r.status, createdAt: r.createdAt })) });
}

export async function POST(req: Request) {
  const a = await authApi(req);
  if (!a) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { projectId?: string; goal?: string } | null;
  const goal = (body?.goal ?? 'full_audit') as RunGoal;
  if (!body?.projectId || !GOALS.includes(goal)) return NextResponse.json({ error: `projectId and goal (${GOALS.join('|')}) required` }, { status: 400 });
  const db = await getDb();
  if (!(await getProject(db, a.orgId, body.projectId).catch(() => null))) return NextResponse.json({ error: 'project not found' }, { status: 404 });
  try {
    const run = await enqueueRun(db, { orgId: a.orgId, projectId: body.projectId, createdBy: a.userId, goal });
    after(() => drainQueue());
    return NextResponse.json({ run: { id: run.id, status: run.status } }, { status: 201 });
  } catch (e) {
    if (e instanceof LimitError) return NextResponse.json({ error: e.message }, { status: 402 });
    throw e;
  }
}
