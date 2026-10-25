import { PLAN_LIMITS, orgOverview, type Plan } from '@stora-sh/db';
import { requireSession } from '@/lib/auth';
import { getDb } from '@/lib/server';
import { Shell } from '@/components/Shell';
import { Bars, Card } from '@/components/ui';
import { changePlan } from '@/lib/actions';

export const dynamic = 'force-dynamic';

export default async function Billing({ searchParams }: { searchParams: Promise<{ limit?: string }> }) {
  const { limit } = await searchParams;
  const s = await requireSession();
  const ov = await orgOverview(await getDb(), s.org.id);
  return (
    <Shell s={s}>
      <h1>Billing</h1>
      {limit && <p className="err" role="alert">{limit}</p>}
      <p className="muted">Billing is stubbed in this MVP: choosing a plan changes your limits immediately and charges nothing.</p>
      {ov && <Card title="Usage"><Bars rows={[
        { label: 'Runs this month', value: ov.runsThisMonth, max: ov.limits.runsPerMonth },
        { label: 'Projects', value: ov.projects, max: ov.limits.projects }]} /></Card>}
      <div className="grid three">
        {(Object.entries(PLAN_LIMITS) as [Plan, (typeof PLAN_LIMITS)[Plan]][]).map(([k, p]) => (
          <Card key={k} title={p.label}>
            <p className="price">${p.priceUsd}<small>/mo</small></p>
            <ul><li>{p.runsPerMonth} runs / month</li><li>{p.projects} project(s)</li></ul>
            {s.org.plan === k ? <button disabled>Current plan</button> : s.role === 'owner' ? <form action={changePlan}><input type="hidden" name="plan" value={k} /><button>Switch to {p.label}</button></form> : <small className="muted">Owner only</small>}
          </Card>
        ))}
      </div>
    </Shell>
  );
}
