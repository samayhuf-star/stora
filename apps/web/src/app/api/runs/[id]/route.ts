import { NextResponse } from 'next/server';
import { getRunDetail, listEvents } from '@stora-sh/db';
import { authApi } from '@/lib/auth';
import { getDb } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await authApi(req);
  if (!a) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const db = await getDb();
  const d = await getRunDetail(db, a.orgId, id);
  if (!d) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const after = Number(new URL(req.url).searchParams.get('after') ?? 0) || 0;
  const events = await listEvents(db, id, after, 300);
  return NextResponse.json({
    run: { id: d.run.id, status: d.run.status, goal: d.run.goal, error: d.run.error, result: d.run.result, createdAt: d.run.createdAt, finishedAt: d.run.finishedAt },
    steps: d.steps.map((s) => ({ agent: s.agent, title: s.title, status: s.status, summary: s.summary, error: s.error, mode: s.mode })),
    artifacts: d.artifacts.map((x) => ({ id: x.id, name: x.name, kind: x.kind, mime: x.mime })),
    events,
  });
}
