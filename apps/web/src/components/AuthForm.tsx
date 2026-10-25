'use client';
import { useActionState } from 'react';
import Link from 'next/link';
import type { FormState } from '@/lib/actions';

export function AuthForm({ mode, action }: { mode: 'login' | 'signup'; action: (s: FormState, f: FormData) => Promise<FormState> }) {
  const [state, run, pending] = useActionState(action, {});
  return (
    <form action={run} className="auth card">
      <h1>{mode === 'login' ? 'Sign in' : 'Create your workspace'}</h1>
      {mode === 'signup' && (<>
        <label>Your name<input name="name" autoComplete="name" defaultValue={state.values?.name} /></label>
        <label>Workspace name<input name="org" placeholder="Acme Apps" defaultValue={state.values?.org} /></label>
      </>)}
      <label>Email<input name="email" type="email" required autoComplete="email" defaultValue={state.values?.email} /></label>
      <label>Password<input name="password" type="password" required minLength={mode === 'signup' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
      {state.error && <p className="err" role="alert">{state.error}</p>}
      <button disabled={pending}>{pending ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
      <p className="muted">{mode === 'login' ? <>New here? <Link href="/signup">Create an account</Link></> : <>Have an account? <Link href="/login">Sign in</Link></>}</p>
    </form>
  );
}
