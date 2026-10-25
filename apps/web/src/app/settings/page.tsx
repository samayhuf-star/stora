import { listApiKeys } from '@stora-sh/db';
import { requireSession } from '@/lib/auth';
import { getDb } from '@/lib/server';
import { Shell } from '@/components/Shell';
import { Card } from '@/components/ui';
import { ApiKeyForm } from '@/components/ApiKeyForm';
import { revokeApiKey } from '@/lib/actions';

export const dynamic = 'force-dynamic';

export default async function Settings() {
  const s = await requireSession();
  const keys = await listApiKeys(await getDb(), s.org.id);
  return (
    <Shell s={s}>
      <h1>API keys</h1>
      <Card title="Create a key"><ApiKeyForm />
        <p className="muted">Use <code>Authorization: Bearer &lt;key&gt;</code> with <code>POST /api/v1/runs {"{ projectId, goal }"}</code>, <code>GET /api/v1/runs</code> and <code>GET /api/v1/projects</code>.</p></Card>
      <Card title="Keys"><table><thead><tr><th>Name</th><th>Prefix</th><th /></tr></thead><tbody>
        {keys.map((k) => <tr key={k.id}><td>{k.name}</td><td><code>{k.prefix}…</code></td><td><form action={revokeApiKey}><input type="hidden" name="id" value={k.id} /><button className="danger">Revoke</button></form></td></tr>)}
        {keys.length === 0 && <tr><td colSpan={3} className="muted">No keys.</td></tr>}
      </tbody></table></Card>
    </Shell>
  );
}
