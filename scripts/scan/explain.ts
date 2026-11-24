/**
 * "Why wasn't this picked up?" for one source item: was it fetched, recorded, triaged (verdict and why), linked?
 *
 *   npm run scan:explain -- --source-item <uuid> [--json]
 *   npm run scan:explain -- --url <permalink> [--json]     a Slack permalink, Lightning record URL, Drive/Docs link, …
 *
 *   npm run scan:explain -- --item <workItemId> [--json]   the resolution check: its pack (lines, never their text) and
 *                                                          every check on the item in plain words, and what runs the next
 *
 * For a Slack permalink that was never recorded it says whether any run covered that moment (a coverage hole, or a
 * search that did not return it). Prints ids, codes, links and short reasons; never the message text.
 */
import { sql } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import { nextCheckText, renderItemExplain } from '../../src/engines/resolution/explain';
import { buildResolutionPack, packLines, ruleInputOfPack } from '../../src/engines/resolution/pack';
import { loadClosingSettings } from '../../src/engines/settle/select-db';
import { evaluateRules } from '../../src/scanner/resolution/rules';
import { explainSourceItem } from '../../src/scanner/trace/queries';
import { closureCheckHistory, loadResolutionForCheck } from '../../src/server/datasource/db/resolution';

import { arg, has, hhmmss, main, open } from './lib';

/** `--item <workItemId>`: the resolution check's pack (rebuilt now, lines without text) and its decisions (H-7, R12). */
async function explainItem(db: Db, userId: string, itemId: string, dbName: string, json: boolean): Promise<number> {
  const now = new Date();
  const settings = await loadClosingSettings(db, userId);
  const loaded = await loadResolutionForCheck(db, userId, itemId, now, settings);
  const checks = await closureCheckHistory(db, userId, itemId, 10);
  const head = (await db.execute<{ kind: string; status: string; title: string }>(sql`select kind::text as kind, status::text as status, title from work_items where owner_user_id = ${userId} and id::text = ${itemId}`)).rows[0];
  if (!head) {
    console.error(`scan:explain: no work item ${itemId} in ${dbName}`);
    return 1;
  }
  let pack: Parameters<typeof renderItemExplain>[0]['pack'] = null;
  if (loaded) {
    const p = buildResolutionPack(loaded.raw, { now, timezone: 'UTC', me: 'me', rules: settings.rules || null });
    const rules = evaluateRules(ruleInputOfPack(p, loaded.raw));
    pack = { tokens: p.tokens, digest: p.digest, trimmed: p.trimmed, hints: { ...p.ruleHints }, rulesFired: rules.fired.map((f) => f.rule), lines: [...packLines(p).values()].map((l) => ({ id: l.id, kind: l.kind, at: l.at, by: l.by, ...(l.where ? { where: l.where } : {}), ...(l.tag ? { tag: l.tag } : {}), ...(l.sourceItemId ? { sourceItemId: l.sourceItemId } : {}) })) };
  }
  const x = { item: { id: itemId, kind: head.kind, status: head.status, title: head.title }, dbName, mode: settings.resolutionEngine, pack, checks, next: nextCheckText(head.status, settings.resolutionEngine, checks[0]?.at ?? null, now) };
  if (json) console.log(JSON.stringify({ ...x, item: { ...x.item, title: undefined } }, null, 2));
  else for (const l of renderItemExplain(x)) console.log(l);
  return 0;
}

void main(async (argv) => {
  const sourceItemId = arg(argv, '--source-item');
  const url = arg(argv, '--url');
  const itemId = arg(argv, '--item');
  if (!sourceItemId && !url && !itemId) {
    console.error('usage: npm run scan:explain -- --source-item <id> | --url <permalink> | --item <workItemId> [--json]');
    return 2;
  }
  const { handle, db, userId, dbName } = await open();
  try {
    if (itemId) return await explainItem(db, userId, itemId, dbName, has(argv, '--json'));
    const x = await explainSourceItem(db, userId, { ...(sourceItemId ? { sourceItemId } : {}), ...(url ? { url } : {}) });
    if (has(argv, '--json')) {
      console.log(JSON.stringify(x, null, 2));
      return x.found ? 0 : 1;
    }
    console.log(`explain ${sourceItemId ?? url} · ${dbName}`);
    if (x.item) {
      const i = x.item;
      console.log(`  item ${i.id} · ${i.source}/${i.kind} · ${i.externalId}`);
      console.log(`  at ${i.occurredAt} · from me ${i.fromMe} · to me ${i.addressedToMe} · first seen ${i.firstSeenAt} · revision ${i.revision}`);
      console.log(`  link ${i.url ?? '(none)'}`);
    }
    console.log(`  fetched: ${x.fetched.length ? '' : x.found ? '(no run listed)' : 'no'}`);
    for (const f of x.fetched) console.log(`    ${f.at?.slice(0, 19) ?? '-'} run ${f.runId} ${f.scope ?? ''} ${f.status}${f.isNew ? ' · new' : ''} (${f.via})`);
    if (x.coverage.length) {
      console.log('  coverage of that moment:');
      for (const c of x.coverage.slice(0, 8)) console.log(`    run ${c.runId} ${c.scope} ${c.kind} ${c.ref ?? ''} ${c.from ?? ''} → ${c.to ?? ''} (${c.outcome})`);
    }
    console.log(`  triage: ${x.triage.length ? '' : 'none'}`);
    for (const t of x.triage) console.log(`    ${hhmmss(t.at)} run ${t.runId} ${t.pass}: ${t.decision}${t.why ? ` · ${t.why}` : ''}`);
    console.log(`  outcomes: ${x.outcomes.length ? '' : 'none'}`);
    for (const o of x.outcomes) console.log(`    ${hhmmss(o.at)} ${o.kind}${o.role ? ` ${o.role}` : ''}${o.confidence ? ` (${o.confidence})` : ''}${o.workItemId ? ` → wi ${o.workItemId}` : ''}${o.reason ? ` · ${o.reason}` : ''}${o.runId ? ` · run ${o.runId}` : ''}`);
    if (x.evidence.length) {
      console.log('  evidence:');
      for (const e of x.evidence) console.log(`    ${e.role} of wi ${e.workItemId} (${e.itemStatus ?? '?'}) conf ${e.confidence}`);
    }
    console.log(`  → ${x.verdict}`);
    return x.found ? 0 : 1;
  } finally {
    await handle.close();
  }
});
