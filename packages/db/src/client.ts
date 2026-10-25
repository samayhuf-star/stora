import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';
import { migrations } from './migrations.generated.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** node-postgres and PGlite both return `{ rows }` from raw execute(); normalise it. */
export function rowsOf<T = Record<string, unknown>>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  return ((res as { rows?: T[] } | null)?.rows ?? []) as T[];
}

export interface StoraDb {
  db: Db;
  /** 'postgres' when DATABASE_URL is set, otherwise embedded 'pglite' */
  kind: 'postgres' | 'pglite';
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  /** Postgres connection string. Falls back to process.env.DATABASE_URL. */
  url?: string;
  /** PGlite data directory (default ./.data/pglite). Use 'memory://' for tests. */
  dataDir?: string;
  /** Run pending migrations on connect (default true) */
  migrate?: boolean;
}

export async function createDb(options: CreateDbOptions = {}): Promise<StoraDb> {
  const url = options.url ?? process.env.DATABASE_URL;
  let handle: StoraDb;

  if (url) {
    const [{ drizzle }, pg] = await Promise.all([import('drizzle-orm/node-postgres'), import('pg')]);
    const pool = new pg.default.Pool({ connectionString: url, max: 10 });
    handle = {
      db: drizzle(pool, { schema }) as unknown as Db,
      kind: 'postgres',
      close: () => pool.end(),
    };
  } else {
    const [{ drizzle }, { PGlite }] = await Promise.all([import('drizzle-orm/pglite'), import('@electric-sql/pglite')]);
    const dataDir = options.dataDir ?? process.env.PGLITE_DIR ?? './.data/pglite';
    if (!dataDir.startsWith('memory://')) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(dataDir, { recursive: true });
    }
    const client = new PGlite(dataDir);
    await client.waitReady;
    handle = {
      db: drizzle(client, { schema }) as unknown as Db,
      kind: 'pglite',
      close: () => client.close(),
    };
  }

  if (options.migrate !== false) await runMigrations(handle.db);
  return handle;
}

/** Applies bundled migrations once each, serialised across processes by an advisory lock. */
export async function runMigrations(db: Db): Promise<string[]> {
  const applied: string[] = [];
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(727274)`);
    await tx.execute(
      sql`create table if not exists stora_migrations (id text primary key, applied_at timestamptz not null default now())`
    );
    const done = await tx.execute(sql`select id from stora_migrations`);
    const seen = new Set(rowsOf<{ id: string }>(done).map((r) => r.id));
    for (const m of migrations) {
      if (seen.has(m.id)) continue;
      for (const statement of m.statements) await tx.execute(sql.raw(statement));
      await tx.execute(sql`insert into stora_migrations (id) values (${m.id})`);
      applied.push(m.id);
    }
  });
  return applied;
}
