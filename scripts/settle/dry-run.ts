/**
 * Settle dry run: judge work items with the Settle check and save the verdicts. Reads the database, writes nothing
 * to it. Output goes to the private stress folder (mode 600), never the repo.
 *
 *   npx tsx scripts/settle/dry-run.ts --all                       # every item, any status
 *   npx tsx scripts/settle/dry-run.ts --ids <file>                # ids, one per line (or JSONL with item_id)
 *   npx tsx scripts/settle/dry-run.ts --show <item id>            # print the context pack only (no model call)
 *   options: --out <file.jsonl> --concurrency 6 --model claude-haiku-5-5 --label <name> --escalate [--escalate-usd 3]
 *
 * Prints counts and spend only, never titles or message text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { inStateDir } from '../../src/lib/state-folder';

import { sql } from 'drizzle-orm';

import { createDb, resolveDatabaseUrl } from '../../src/db/client';
import { renderSettlePrompt } from '../../src/engines/settle/prompt';
import { buildSettleContext } from '../../src/engines/settle/context';
import { loadSettleRaw, loadSettleUser } from '../../src/engines/settle/load-db';
import { SETTLE_STRONG_MODEL, settleMany } from '../../src/engines/settle/run';
import { agentSdkCompletionModel } from '../../src/scanner/completion/llm';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const PRIVATE = inStateDir('stress', 'settle-key', 'runs');

const handle = createDb({ url: resolveDatabaseUrl(), max: 4, applicationName: 'command-center-settle-dry-run' });
let code = 0;
try {
  const user = await loadSettleUser(handle.db);
  const now = new Date();
  const base = { now, timezone: user.timezone, me: user.me };
  const show = opt('show');
  if (show) {
    const raw = await loadSettleRaw(handle.db, user.userId, show, { now });
    if (!raw) throw new Error('no such item');
    console.log(JSON.stringify(JSON.parse(renderSettlePrompt(buildSettleContext(raw, base))), null, 2));
  } else {
    let ids: string[] = [];
    if (args.includes('--all')) {
      ids = ((await handle.db.execute(sql`select id::text as id from work_items where owner_user_id = ${user.userId} order by created_at`)).rows as Array<{ id: string }>).map((r) => r.id);
    } else if (opt('ids')) {
      ids = fs
        .readFileSync(opt('ids')!, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => (l.startsWith('{') ? (JSON.parse(l) as { item_id: string }).item_id : l));
    } else throw new Error('pass --all, --ids <file> or --show <id>');
    fs.mkdirSync(PRIVATE, { recursive: true, mode: 0o700 });
    const label = opt('label') ?? new Date().toISOString().replace(/[:.]/g, '-');
    const out = opt('out') ?? path.join(PRIVATE, `${label}.jsonl`);
    const ctxOut = out.replace(/\.jsonl$/, '.contexts.jsonl');
    fs.writeFileSync(out, '', { mode: 0o600 });
    fs.writeFileSync(ctxOut, '', { mode: 0o600 });
    let n = 0;
    let cost = 0;
    const counts: Record<string, number> = {};
    const call = agentSdkCompletionModel({ timeoutMs: 120_000 });
    await settleMany(ids, (id) => loadSettleRaw(handle.db, user.userId, id, { now }), call, {
      ...base,
      concurrency: Number(opt('concurrency') ?? 6),
      ...(opt('model') ? { model: opt('model') } : {}),
      ...(args.includes('--escalate') ? { escalate: { model: SETTLE_STRONG_MODEL, maxUsd: Number(opt('escalate-usd') ?? 3) } } : {}),
      onResult: (r, ctx) => {
        n += 1;
        cost += r.costUsd;
        counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
        const { cite, ...rest } = r;
        fs.appendFileSync(out, `${JSON.stringify({ ...rest, cite: cite ? { id: cite.id, kind: cite.kind, at: cite.at, by: cite.fromMe ? 'me' : 'other', sourceItemId: cite.sourceItemId, url: cite.url, calendarEventId: cite.calendarEventId, workItemId: cite.workItemId } : null })}\n`);
        fs.appendFileSync(ctxOut, `${JSON.stringify(ctx)}\n`);
        if (n % 25 === 0) console.log(`progress ${n}/${ids.length} $${cost.toFixed(3)}`);
      },
    });
    console.log(JSON.stringify({ items: n, of: ids.length, costUsd: Number(cost.toFixed(4)), verdicts: counts, out: path.basename(out) }));
  }
} catch (err) {
  console.error(`settle dry run: ${(err as Error).message}`);
  code = 1;
} finally {
  await handle.close();
}
process.exit(code);
