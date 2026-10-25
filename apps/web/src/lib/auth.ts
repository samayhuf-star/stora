import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getMembership, getUserById, listOrgsForUser, verifyApiKey } from '@stora-sh/db';
import { getDb } from './server';

const COOKIE = 'stora_session';
const MAX_AGE = 60 * 60 * 24 * 14;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET (>=16 chars) is required in production');
  return 'dev-only-insecure-secret-change-me';
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');

export function makeToken(uid: string): string {
  const payload = Buffer.from(JSON.stringify({ uid, exp: Date.now() + MAX_AGE * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readToken(token: string | undefined): string | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const good = sign(payload);
  if (sig.length !== good.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof uid === 'string' && typeof exp === 'number' && exp > Date.now() ? uid : null;
  } catch {
    return null;
  }
}

export async function setSession(uid: string) {
  (await cookies()).set(COOKIE, makeToken(uid), {
    httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1' || (process.env.APP_URL ?? '').startsWith('https://'), path: '/', maxAge: MAX_AGE,
  });
}

export async function clearSession() {
  (await cookies()).delete(COOKIE);
}

export interface Session {
  user: { id: string; email: string; name: string };
  org: NonNullable<Awaited<ReturnType<typeof getMembership>>>['org'];
  role: string;
}

/** Current user + their primary workspace, or null. */
export async function getSession(): Promise<Session | null> {
  const uid = readToken((await cookies()).get(COOKIE)?.value);
  if (!uid) return null;
  const db = await getDb();
  const user = await getUserById(db, uid);
  if (!user) return null;
  const [first] = await listOrgsForUser(db, uid);
  if (!first) return null;
  return { user: { id: user.id, email: user.email, name: user.name }, org: first.org, role: first.role };
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect('/login');
  return s;
}

/** Resolve the org for an API request: Bearer API key, or session cookie. */
export async function authApi(req: Request): Promise<{ orgId: string; userId: string | null } | null> {
  const h = req.headers.get('authorization');
  if (h?.toLowerCase().startsWith('bearer ')) {
    const org = await verifyApiKey(await getDb(), h.slice(7).trim());
    return org ? { orgId: org.id, userId: null } : null;
  }
  const origin = req.headers.get('origin');
  if (origin && req.method !== 'GET' && new URL(origin).host !== req.headers.get('host')) return null; // CSRF guard
  const s = await getSession();
  return s ? { orgId: s.org.id, userId: s.user.id } : null;
}
