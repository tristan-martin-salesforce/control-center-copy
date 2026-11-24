/**
 * RED-1 one-off: re-redact stored source items with today's rules (password-manager share links, login lines), so
 * credentials recorded before the rules existed leave `source_items` (tenet: Local data, privacy-safe logs).
 *
 *   npx tsx scripts/db/scrub-credentials.ts            dry run: counts only, writes nothing
 *   npx tsx scripts/db/scrub-credentials.ts --apply    rewrites the rows in one change set (undoable)
 *
 * What it rewrites: `body`, `title` and every string in `meta` (the same `redact` / `redactDeep` the ingest uses), the
 * row's redaction flags, and `source_item_refs` rows whose value is a credential (they are deleted). `content_hash` is
 * left as it is, so a later sighting of the same message stays a no-op and the scrubbed text stays.
 * Output is the database name and counts per kind: never a URL, body or matched text. DATABASE_URL picks the database.
 */
import { sql } from 'drizzle-orm';

import { redact, redactDeep } from '../../src/connectors/redact';
import { actors, withChangeSet } from '../../src/db/changeset';
import { createDb, databaseName, resolveDatabaseUrl } from '../../src/db/client';

const PAGE = 500;

type Row = {
  id: string;
  title: string | null;
  body: string | null;
  meta: Record<string, unknown> | null;
  redaction_count: number;
  redaction_kinds: string[] | null;
};

export interface ScrubPlan {
  scanned: number;
  rows: Array<{ id: string; title: string | null; body: string | null; meta: Record<string, unknown>; count: number; kinds: string[] }>;
  refs: string[];
  byKind: Record<string, number>;
}

/** What a scrub would change (pure over the rows it is given). */
export function planScrub(rows: Row[], refs: Array<{ id: string; value: string }>): ScrubPlan {
  const plan: ScrubPlan = { scanned: rows.length, rows: [], refs: [], byKind: {} };
  for (const r of rows) {
    const t = redact(r.title ?? '');
    const b = redact(r.body ?? '');
    const m = redactDeep(r.meta ?? {});
    if (!t.redacted && !b.redacted && !m.redacted) continue;
    const kinds = [...new Set([...t.kinds, ...b.kinds, ...(m.redacted ? ['meta'] : [])])];
    for (const k of kinds) plan.byKind[k] = (plan.byKind[k] ?? 0) + 1;
    plan.rows.push({
      id: r.id,
      title: r.title === null ? null : t.text,
      body: r.body === null ? null : b.text,
      meta: m.value as Record<string, unknown>,
      count: (r.redaction_count ?? 0) + t.count + b.count + (m.redacted ? 1 : 0),
      kinds: [...new Set([...(r.redaction_kinds ?? []), ...kinds])],
    });
  }
  for (const x of refs) if (redact(x.value).redacted) plan.refs.push(x.id);
  return plan;
}

async function run(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const url = resolveDatabaseUrl();
  const handle = createDb({ url, max: 2, applicationName: 'command-center-scrub' });
  try {
    const u = await handle.db.execute<{ id: string }>(sql`select id from users where is_active order by created_at limit 1`);
    const userId = u.rows[0]?.id;
    if (!userId) throw new Error(`no user in ${databaseName(url)}`);
    const rows: Row[] = [];
    for (let after = '00000000-0000-0000-0000-000000000000'; ; ) {
      const page = await handle.db.execute<Row>(sql`
        select id, title, body, meta, redaction_count, redaction_kinds from source_items
         where owner_user_id = ${userId} and id > ${after}::uuid order by id limit ${PAGE}`);
      rows.push(...page.rows);
      if (page.rows.length < PAGE) break;
      after = page.rows[page.rows.length - 1]!.id;
    }
    const refs = await handle.db.execute<{ id: string; value: string }>(sql`
      select r.id::text as id, r.value from source_item_refs r join source_items si on si.id = r.source_item_id where si.owner_user_id = ${userId}`);
    const plan = planScrub(rows, refs.rows);
    const kinds = Object.entries(plan.byKind).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    console.log(`scrub-credentials · ${databaseName(url)} · ${apply ? 'APPLY' : 'dry run'}`);
    console.log(`  scanned ${plan.scanned} source item(s): ${plan.rows.length} to rewrite (${kinds}); ${plan.refs.length} credential ref(s) to delete`);
    if (!apply || (!plan.rows.length && !plan.refs.length)) {
      if (!apply && (plan.rows.length || plan.refs.length)) console.log('  nothing written; run with --apply to rewrite');
      return 0;
    }
    const cs = await withChangeSet({ db: handle.db, userId, actor: actors.system('scrub-credentials'), reason: 'RED-1: re-redact stored source items (share links, login lines)' }, async (tx) => {
      for (const r of plan.rows) {
        await tx.execute(sql`
          update source_items set title = ${r.title}, body = ${r.body}, meta = ${JSON.stringify(r.meta)}::jsonb,
                 redacted = ${r.count > 0}, redaction_count = ${r.count}, redaction_kinds = ${`{${r.kinds.map((k) => `"${k.replace(/"/g, '')}"`).join(',')}}`}::text[]
           where id = ${r.id}::uuid and owner_user_id = ${userId}`);
      }
      if (plan.refs.length) await tx.execute(sql`delete from source_item_refs where id = any(${`{${plan.refs.join(',')}}`}::bigint[])`);
      return plan.rows.length;
    });
    console.log(`  rewrote ${cs.result} row(s), deleted ${plan.refs.length} ref(s) · change set ${cs.changeSetId}`);
    return 0;
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && /scrub-credentials\.ts$/.test(process.argv[1])) {
  run(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err: unknown) => {
      console.error(`error: ${(err as Error).message}`);
      process.exitCode = 1;
    },
  );
}
