'use client';
import { useActionState } from 'react';
import { addProject } from '@/lib/actions';

export function ProjectForm() {
  const [state, run, pending] = useActionState(addProject, {});
  return (
    <form action={run} className="card form">
      <label>App name<input defaultValue={state.values?.name} name="name" required /></label>
      <label>Git repository URL (https)<input defaultValue={state.values?.repoUrl} name="repoUrl" required placeholder="https://github.com/org/app" /></label>
      <div className="row">
        <label>Branch<input defaultValue={state.values?.branch} name="branch" placeholder="main" /></label>
        <label>Platform<select name="platform" defaultValue="both"><option value="both">iOS + Android</option><option value="ios">iOS</option><option value="android">Android</option></select></label>
      </div>
      <div className="row">
        <label>iOS bundle ID (optional)<input defaultValue={state.values?.bundleId} name="bundleId" placeholder="com.acme.app" /></label>
        <label>Android package (optional)<input defaultValue={state.values?.packageName} name="packageName" placeholder="com.acme.app" /></label>
      </div>
      <label>Category (optional)<input defaultValue={state.values?.category} name="category" placeholder="Health & Fitness" /></label>
      {state.error && <p className="err" role="alert">{state.error}</p>}
      <button disabled={pending}>{pending ? 'Creating…' : 'Create project'}</button>
    </form>
  );
}
