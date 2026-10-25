import { NextResponse } from 'next/server';
import { getArtifact } from '@stora-sh/db';
import { authApi } from '@/lib/auth';
import { getDb } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await authApi(req);
  if (!a) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const art = await getArtifact(await getDb(), a.orgId, id);
  if (!art) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (art.url && !art.content) return NextResponse.redirect(art.url);
  const safe = art.name.replace(/[^\w.\- ]/g, '_');
  return new Response(art.content ?? '', {
    headers: {
      // never render untrusted artifact content as HTML in our origin
      'content-type': art.mime === 'application/json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${safe}"`,
      'x-content-type-options': 'nosniff',
    },
  });
}
