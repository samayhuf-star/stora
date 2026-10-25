import { requireSession } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import { ProjectForm } from '@/components/ProjectForm';

export default async function NewProject() {
  const s = await requireSession();
  return <Shell s={s}><h1>New project</h1><p className="muted">Connect a public git repository. Agents clone it read-only, never run its code, and remove the clone afterwards.</p><ProjectForm /></Shell>;
}
