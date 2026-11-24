/**
 * 2026-11-13 audit C1: one table → topic map, and every audited table resolves to a topic. Before, the db DataSource's
 * bus kept its own copy without deal_contribution_requests, meeting_notes, canvases, job_schedules, channels or
 * work_item_deliverables: a DC claimed (on Deals or by the Assistant's Apply) refreshed Deals ▸ DCs and Time ▸ Log it
 * only on a reload.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { eventsForChanges, TABLE_TOPICS, topicsFor } from '@/server/events/topics';

const ROOT = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(ROOT, 'src/db/migrations');

/** Every table the migrations attach cc_audit / cc_audit_kv to, with the root entity type the trigger records. */
function auditedTables(): Array<{ table: string; root: string }> {
  const out = new Map<string, string>();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql'))) {
    const sql = readFileSync(path.join(MIGRATIONS, f), 'utf8');
    // the attach loop: ('table', 'root entity type', 'root id column', '{omit}')
    for (const block of sql.matchAll(/FOR r IN SELECT \* FROM \(VALUES([\s\S]*?)\) AS t\(tbl, entity_type/g)) {
      for (const m of block[1]!.matchAll(/\(\s*'(\w+)',\s*'(\w+)',\s*'(\w+)',\s*'\{[^}]*\}'\s*\)/g)) out.set(m[1]!, m[2]!);
    }
    // one-off triggers: CREATE TRIGGER x AFTER … ON <table> … EXECUTE FUNCTION cc_audit('<root>', …) / cc_audit_kv('<root>', …)
    for (const m of sql.matchAll(/CREATE TRIGGER \w+ AFTER [\w\s]+? ON (\w+)[\s\S]*?EXECUTE FUNCTION cc_audit(?:_kv)?\('(\w+)'/g)) out.set(m[1]!, m[2]!);
  }
  return [...out].map(([table, root]) => ({ table, root }));
}

describe('the one table → topic map', () => {
  const tables = auditedTables();

  it('finds the audited tables in the migrations (the parser still matches them)', () => {
    expect(tables.length).toBeGreaterThan(40);
    expect(tables.map((x) => x.table)).toEqual(expect.arrayContaining(['work_items', 'deal_contribution_requests', 'meeting_notes', 'canvases', 'job_schedules', 'channels', 'work_item_deliverables', 'source_items', 'user_settings', 'activity_entry_time_blocks']));
  });

  it.each(auditedTables())('$table (root $root) resolves to at least one topic, by its own table', ({ table, root }) => {
    expect(TABLE_TOPICS[table], `${table} has no entry in TABLE_TOPICS (src/server/events/topics.ts)`).toBeDefined();
    expect(topicsFor(table, root).length).toBeGreaterThan(0);
    // the root too: the change-set publisher falls back to it for a row whose table it does not know
    expect(topicsFor(undefined, root).length, `root ${root} of ${table} has no topics`).toBeGreaterThan(0);
  });

  it('every table the db DataSource publishes after an unaudited write resolves too', () => {
    // R7: the db DataSource's domains live in db/domains/*.ts
    const domains = (() => {
      try {
        return readdirSync(path.join(ROOT, 'src/server/datasource/db/domains')).map((f) => `src/server/datasource/db/domains/${f}`);
      } catch {
        return [];
      }
    })();
    const src = ['src/server/datasource/db/index.ts', 'src/server/datasource/db/ctx.ts', ...domains, 'src/server/datasource/db/chat-be6.ts', 'src/server/datasource/db/vdp.ts', 'src/server/datasource/db/forecast.ts']
      .map((f) => path.join(ROOT, f))
      .filter((f) => {
        try {
          readFileSync(f);
          return true;
        } catch {
          return false;
        }
      })
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const named = new Set<string>();
    for (const m of src.matchAll(/publishTables\(\[([^\]]*)\]/g)) for (const t of m[1]!.matchAll(/'(\w+)'/g)) named.add(t[1]!);
    expect(named.size).toBeGreaterThan(5);
    for (const t of named) expect(topicsFor(t).length, `publishTables(['${t}']) invalidates nothing`).toBeGreaterThan(0);
  });

  it('a claimed DC refreshes Deals ▸ DCs, Time ▸ Log it, the sidebar badge and Home', () => {
    expect(topicsFor('deal_contribution_requests')).toEqual(expect.arrayContaining(['deals', 'time', 'today', 'home']));
    const ev = eventsForChanges([{ entityType: 'deal_contribution_requests', table: 'deal_contribution_requests', entityId: 'dcr_1', op: 'insert' }]);
    expect(ev.map((e) => e.topic)).toEqual(expect.arrayContaining(['deals', 'time', 'today', 'home']));
    expect(ev.every((e) => e.reason === 'dc_request.created')).toBe(true);
  });

  it('a child row resolves by its own table first, then by its root', () => {
    expect(topicsFor('work_item_evidence', 'work_items')).toEqual(['item']);
    expect(topicsFor('no_such_table', 'work_items')).toEqual(TABLE_TOPICS.work_items!.topics);
    expect(topicsFor('no_such_table')).toEqual([]);
  });

  it('a row of an unknown table still says something changed (audit)', () => {
    expect(eventsForChanges([{ entityType: 'mystery', entityId: 'x', op: 'update' }]).map((e) => e.topic)).toEqual(['audit']);
  });
});

/** Every table 0026_live_notify (or a later migration) attaches cc_live_notify / cc_live_notify_stmt to. */
function liveNotifiedTables(): string[] {
  const out = new Set<string>();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql'))) {
    const sql = readFileSync(path.join(MIGRATIONS, f), 'utf8');
    for (const m of sql.matchAll(/CREATE TRIGGER \w+ AFTER [\w\s]+? ON (\w+)[\s\S]*?EXECUTE FUNCTION cc_live_notify(?:_stmt)?\(\)/g)) out.add(m[1]!);
  }
  return [...out];
}

describe('2026-11-14 live pass: the unaudited tables the UI used to poll push too', () => {
  const tables = liveNotifiedTables();

  it('finds the trigger in the migrations (the parser still matches it)', () => {
    expect(tables).toEqual(expect.arrayContaining(['jobs', 'scan_runs', 'tool_runs', 'app_events', 'worker_instances', 'vdp_records', 'specialist_forecasts', 'org62_use_cases', 'record_landings', 'landing_writes', 'use_cases']));
  });

  it.each(liveNotifiedTables())('%s resolves to at least one topic (its notice names the table as its own root)', (table) => {
    expect(TABLE_TOPICS[table], `${table} has no entry in TABLE_TOPICS (src/server/events/topics.ts)`).toBeDefined();
    expect(topicsFor(table, table).length).toBeGreaterThan(0);
  });

  it("Health, the tool run panel and the progress views follow their tables' topics", () => {
    expect(topicsFor('jobs')).toEqual(expect.arrayContaining(['jobs', 'health']));
    expect(topicsFor('scan_runs')).toEqual(expect.arrayContaining(['scans', 'health']));
    expect(topicsFor('tool_runs')).toEqual(expect.arrayContaining(['tool_run', 'agents']));
    expect(topicsFor('worker_instances')).toEqual(['health']);
    expect(topicsFor('org62_use_cases')).toEqual(expect.arrayContaining(['time', 'deals']));
    // a `tx:` change set (the trigger's) groups like any other, by table
    const ev = eventsForChanges([{ entityType: 'jobs', table: 'jobs', entityId: '42', op: 'insert' }]);
    expect(ev.map((e) => e.topic).sort()).toEqual(['health', 'jobs']);
  });
});
