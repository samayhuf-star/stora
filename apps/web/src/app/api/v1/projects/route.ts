import { NextResponse } from 'next/server';
import { listProjects } from '@stora-sh/db';
import { authApi } from '@/lib/auth';
import { getDb } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const a = await authApi(req);
  if (!a) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const rows = await listProjects(await getDb(), a.orgId);
  return NextResponse.json({ projects: rows.map((p) => ({ id: p.id, name: p.name, repoUrl: p.repoUrl, branch: p.branch, platform: p.platform })) });
}
