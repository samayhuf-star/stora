import { NextResponse } from 'next/server';
import { drainQueue } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Safety net for serverless: picks up queued or abandoned runs. Vercel Cron sends CRON_SECRET as a Bearer token. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  await drainQueue(5);
  return NextResponse.json({ ok: true });
}
