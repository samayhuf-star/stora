'use server';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import {
  LimitError, createApiKey, createProject, createUserWithOrg, deleteApiKey, deleteProject,
  enqueueRun, getUserByEmail, requestCancel, setOrgPlan, type Plan, type RunGoal, type TargetPlatform,
} from '@stora-sh/db';
import { validateRepoUrl } from '@stora-sh/agents';
import { clearSession, hashPassword, requireSession, setSession, verifyPassword } from './auth';
import { drainQueue, getDb } from './server';

export interface FormState { error?: string; ok?: string; secret?: string; values?: Record<string, string> }
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export async function signup(_: FormState, f: FormData): Promise<FormState> {
  const email = str(f, 'email').toLowerCase(), name = str(f, 'name'), pw = String(f.get('password') ?? '');
  const values = { email, name, org: str(f, 'org') };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'Enter a valid email address.', values };
  if (pw.length < 8) return { error: 'Password must be at least 8 characters.', values };
  try {
    const { user } = await createUserWithOrg(await getDb(), { email, name: name || email.split('@')[0], passwordHash: hashPassword(pw), orgName: str(f, 'org') || undefined });
    await setSession(user.id);
  } catch (e) {
    if ((e as Error).message === 'EMAIL_TAKEN') return { error: 'An account with this email already exists.', values };
    throw e;
  }
  redirect('/dashboard');
}

export async function login(_: FormState, f: FormData): Promise<FormState> {
  const user = await getUserByEmail(await getDb(), str(f, 'email'));
  // verify against a dummy hash when the user is unknown so timing doesn't reveal accounts
  const ok = user ? verifyPassword(String(f.get('password') ?? ''), user.passwordHash) : (verifyPassword('x', 'scrypt$00$00'), false);
  if (!user || !ok) return { error: 'Invalid email or password.', values: { email: str(f, 'email') } };
  await setSession(user.id);
  redirect('/dashboard');
}

export async function logout() {
  await clearSession();
  redirect('/login');
}

export async function addProject(_: FormState, f: FormData): Promise<FormState> {
  const s = await requireSession();
  const repoUrl = str(f, 'repoUrl'), name = str(f, 'name');
  const values = { name, repoUrl, branch: str(f, 'branch'), bundleId: str(f, 'bundleId'), packageName: str(f, 'packageName'), category: str(f, 'category') };
  if (!name) return { error: 'Give the project a name.', values };
  try { validateRepoUrl(repoUrl); } catch (e) { return { error: (e as Error).message, values }; }
  let id: string;
  try {
    const p = await createProject(await getDb(), s.org.id, {
      name, repoUrl, branch: str(f, 'branch') || 'main',
      platform: (str(f, 'platform') || 'both') as TargetPlatform,
      bundleId: str(f, 'bundleId') || null, packageName: str(f, 'packageName') || null,
      settings: { appName: name, category: str(f, 'category') || undefined, locale: 'en-US' } as never,
    });
    id = p.id;
  } catch (e) {
    if (e instanceof LimitError) return { error: e.message, values };
    throw e;
  }
  redirect(`/projects/${id}`);
}

export async function removeProject(f: FormData) {
  const s = await requireSession();
  await deleteProject(await getDb(), s.org.id, str(f, 'id'));
  revalidatePath('/dashboard');
  redirect('/dashboard');
}

export async function startRun(f: FormData) {
  const s = await requireSession();
  const goal = (str(f, 'goal') || 'full_audit') as RunGoal;
  let runId: string;
  try {
    const run = await enqueueRun(await getDb(), { orgId: s.org.id, projectId: str(f, 'projectId'), createdBy: s.user.id, goal });
    runId = run.id;
    after(() => drainQueue());
  } catch (e) {
    if (e instanceof LimitError) redirect(`/billing?limit=${encodeURIComponent(e.message)}`);
    throw e;
  }
  redirect(`/runs/${runId}`);
}

export async function cancelRun(f: FormData) {
  const s = await requireSession();
  await requestCancel(await getDb(), s.org.id, str(f, 'id'));
  revalidatePath(`/runs/${str(f, 'id')}`);
}

/** Billing is stubbed: switching plans just flips the plan row (no payment provider). */
export async function changePlan(f: FormData) {
  const s = await requireSession();
  if (s.role !== 'owner') return;
  const plan = str(f, 'plan');
  if (plan !== 'free' && plan !== 'pro' && plan !== 'agency') return;
  await setOrgPlan(await getDb(), s.org.id, plan as Plan);
  revalidatePath('/billing');
  redirect('/billing');
}

export async function newApiKey(_: FormState, f: FormData): Promise<FormState> {
  const s = await requireSession();
  const k = await createApiKey(await getDb(), s.org.id, str(f, 'name') || 'default');
  revalidatePath('/settings');
  return { ok: 'Key created. Copy it now; it is shown only once.', secret: (k as { key?: string; raw?: string }).key ?? (k as { raw?: string }).raw };
}

export async function revokeApiKey(f: FormData) {
  const s = await requireSession();
  await deleteApiKey(await getDb(), s.org.id, str(f, 'id'));
  revalidatePath('/settings');
}
