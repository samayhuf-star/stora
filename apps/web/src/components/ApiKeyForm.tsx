'use client';
import { useActionState } from 'react';
import { newApiKey } from '@/lib/actions';

export function ApiKeyForm() {
  const [state, run, pending] = useActionState(newApiKey, {});
  return (
    <form action={run} className="row">
      <input name="name" placeholder="Key name (e.g. CI)" />
      <button disabled={pending}>Create key</button>
      {state.secret && <p className="ok-note"><code>{state.secret}</code><br />{state.ok}</p>}
    </form>
  );
}
