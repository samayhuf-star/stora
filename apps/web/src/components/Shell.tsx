import Link from 'next/link';
import type { ReactNode } from 'react';
import { logout } from '@/lib/actions';
import type { Session } from '@/lib/auth';

export function Shell({ s, children }: { s: Session; children: ReactNode }) {
  return (
    <>
      <nav className="nav">
        <Link href="/dashboard" className="brand">Stora <b>Launch Copilot</b></Link>
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/projects/new">New project</Link>
        <Link href="/billing">Billing</Link>
        <Link href="/settings">API keys</Link>
        <span className="grow" />
        <span className="who">{s.org.name} · {s.org.plan}</span>
        <form action={logout}><button className="link">Sign out</button></form>
      </nav>
      <main className="page">{children}</main>
    </>
  );
}
