// DbScannerStore state and shared reads. Split from store-db.ts (max-lines); the class is still exported from store-db.ts.
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

import { redact } from '@/connectors/redact';
import { actors, withChangeSet } from '@/db/changeset';
import { getDb, type Db, type DbOrTx, type Tx } from '@/db/client';
import { closureSettingsFrom } from '@/engines/closure/signals';
import { loadClosingSettings } from '@/engines/settle/select-db';
import { CLOSURE_SETTING_KEYS } from '@/engines/types';
import type { OpenItemDigestExt } from './runtime/contract-ext';
import type { ResolvedPersona } from '../personas/types';
import { loadPersona } from '../server/datasource/db/store/persona';
import { mergeRanges, NotFoundError as StoreNotFoundError, RunStateError, tokenize, toMs } from './store-memory';
import {
  scanningPrefsOf, scopeId, type ConnectorHealthProbe, type ConnectorId, type Cursor, type ScanContext,
  type ScanningPrefs, type ScanTrigger, type ScopeKey, type TimeWindow,
} from './types';
import {
  type DbScannerStoreOptions, CONNECTOR_META, isPrimaryOfKind, type ConnectorStatus, readSkillVersion, modelTierOf,
  type RunState, RUNS, UUID, TRIGGER_MAP, iso, uuidArr, textArr, REOPEN_WINDOW_MS, type DigestRow, normPerson,
  type Range, isoMs, TOL, type BudgetStatus, localDay,
} from './store-db.shared';
import { failureCode } from './store-db.rows';

/** DbScannerStore's state and the reads its write paths share: ids, runs, digests, persona and settings, cursors, coverage, budget. */
export abstract class DbScannerStoreBase {
  readonly userId: string;
  protected readonly db: Db;
  protected readonly clock: () => Date;
  protected readonly skillsDir: string;
  protected readonly connectorIds = new Map<ConnectorId, string>();
  protected readonly extractorIds = new Map<string, string>();
  protected tz: string | undefined;
  /** PPL-1: author key (`slack:U…`, `email:…`, `me`) → people.id, resolved once per store. */
  protected readonly persons = new Map<string, string>();
  /** PPL-1: author keys with no person (an email sender nobody knows) → when looked up; asked again after 10 min. */
  protected readonly noPerson = new Map<string, number>();
  protected readonly o: DbScannerStoreOptions & { defaultBudget: { softUsd: number; hardUsd: number; alertPct?: number } };

  constructor(opts: DbScannerStoreOptions) {
    this.userId = opts.userId;
    this.db = opts.db ?? getDb();
    this.clock = opts.clock ?? (() => new Date());
    this.skillsDir = opts.skillsDir ?? join(process.cwd(), 'skills');
    this.o = { defaultBudget: { softUsd: 5, hardUsd: 15, alertPct: 80 }, ...opts };
  }

  protected now(): Date {
    return this.clock();
  }

  protected cs<T>(connector: ConnectorId | string, reason: string, fn: (tx: Tx) => Promise<T>, undoable = true): Promise<T> {
    return withChangeSet({ db: this.db, userId: this.userId, actor: actors.scanner(connector), reason, undoable }, (tx) => fn(tx)).then(
      (r) => r.result,
    );
  }

  // ------------------------------------------------------------------ lookups

  /** The connectors row for a ConnectorId (created on first use). */
  async connectorId(connector: ConnectorId): Promise<string> {
    const hit = this.connectorIds.get(connector);
    if (hit) return hit;
    const meta = CONNECTOR_META[connector];
    if (!meta) throw new RangeError(`unknown connector ${connector}`);
    const find = async (db: DbOrTx) => {
      const rows = (
        await db.execute<{ id: string; name: string }>(
          sql`select id, name from connectors where owner_user_id = ${this.userId} and kind = ${meta.kind} order by created_at, id`,
        )
      ).rows;
      const exact = rows.find((r) => r.name === connector);
      if (exact) return exact.id;
      // The app seeds connectors with name = their label ("Gmail"): that row IS this connector. The kind's primary
      // scanner connector adopts it (Trainings and Watch share a kind and keep rows of their own). Before, the
      // scanner registered a second row, so Health's connector never showed scanner state and a Health "Rescan"
      // placeholder (on the seeded row) was never adopted by the run (stress finding CONN-1).
      if (!isPrimaryOfKind(connector)) return undefined;
      const seeded = rows.filter((r) => !(r.name in CONNECTOR_META));
      return (seeded.find((r) => r.name.toLowerCase() === meta.label.toLowerCase()) ?? seeded[0])?.id;
    };
    let id = await find(this.db);
    if (!id) {
      id = await this.cs(
        connector,
        `register connector ${connector}`,
        async (tx) => {
          await tx.execute(sql`
            insert into connectors (owner_user_id, kind, name, transport, config)
            values (${this.userId}, ${meta.kind}, ${connector}, ${meta.transport}, ${JSON.stringify({ label: meta.label })}::jsonb)
            on conflict (owner_user_id, kind, name) do nothing`);
          return (await find(tx))!;
        },
        false,
      );
    }
    this.connectorIds.set(connector, id);
    return id;
  }

  /**
   * E3: `connectors.status = auth_required` survives a restart; the runtime reads it at startup. Since the last auth
   * failure (last_error_at), so a sign-in refreshed and then refused again still counts as refused.
   */
  async authPausedSince(connector: ConnectorId): Promise<string | null> {
    const id = await this.connectorId(connector);
    const r = await this.db.execute<{ status: ConnectorStatus; at: Date | string | null }>(sql`
      select status, greatest(last_error_at, status_changed_at) as at from connectors where id = ${id}`);
    const row = r.rows[0];
    return row?.status === 'auth_required' ? (row.at ? new Date(row.at).toISOString() : this.now().toISOString()) : null;
  }

  /** Current connectors.status (null before the first write). */
  async connectorStatus(connector: ConnectorId): Promise<ConnectorStatus | null> {
    const id = await this.connectorId(connector);
    const r = await this.db.execute<{ status: ConnectorStatus }>(sql`select status from connectors where id = ${id}`);
    return r.rows[0]?.status ?? null;
  }

  protected async extractorId(connector: ConnectorId, skillVersion: string | undefined, model?: string): Promise<string> {
    const key = `scanner:${connector}`;
    const version = skillVersion || readSkillVersion(CONNECTOR_META[connector]?.skill, this.skillsDir);
    const cacheKey = `${key}@${version}`;
    const hit = this.extractorIds.get(cacheKey);
    if (hit) return hit;
    const tier = modelTierOf(model);
    await this.db.execute(sql`
      insert into extractors (key, version, kind, model_tier, model, skill_key, description)
      values (${key}, ${version}, ${tier === 'none' ? 'parser' : 'llm'}, ${tier}, ${model ?? null},
              ${CONNECTOR_META[connector]?.skill ?? null}, ${`Scanner ${connector} (skill ${version})`})
      on conflict (key, version) do nothing`);
    const res = await this.db.execute<{ id: string }>(sql`select id from extractors where key = ${key} and version = ${version}`);
    const id = res.rows[0]!.id;
    this.extractorIds.set(cacheKey, id);
    return id;
  }

  protected async timezone(): Promise<string> {
    if (this.tz) return this.tz;
    const res = await this.db.execute<{ timezone: string; profile_tz: string | null }>(sql`
      select u.timezone, (select s.value->>'timezone' from user_settings s where s.owner_user_id = u.id and s.key in ('settings.profile', 'profile') order by (s.key = 'settings.profile') desc limit 1) as profile_tz
        from users u where u.id = ${this.userId}`);
    const row = res.rows[0];
    if (!row) throw new StoreNotFoundError(`user ${this.userId}`);
    this.tz = row.profile_tz || row.timezone || 'America/Denver';
    return this.tz;
  }

  protected async run(runId: string): Promise<RunState> {
    const hit = RUNS.get(runId);
    if (hit) return hit;
    if (!UUID.test(runId)) throw new RunStateError(`unknown run ${runId}`);
    // Another store instance (or a restart) opened it: rebuild what we can. Staged coverage is per process.
    const res = await this.db.execute<{
      connector_id: string;
      name: string;
      scope: string;
      trigger: string;
      window_start: string | null;
      window_end: string | null;
      skill_version: string | null;
    }>(sql`
      select r.connector_id, c.name, r.scope, r.trigger, r.window_start, r.window_end, r.skill_version
        from scan_runs r join connectors c on c.id = r.connector_id
       where r.id = ${runId} and r.owner_user_id = ${this.userId}`);
    const r = res.rows[0];
    if (!r) throw new RunStateError(`unknown run ${runId}`);
    const connector = r.name as ConnectorId;
    const scope = r.scope.startsWith(`${connector}:`) ? r.scope.slice(connector.length + 1) : r.scope;
    const trigger = (Object.entries(TRIGGER_MAP).find(([, v]) => v === r.trigger)?.[0] ?? 'schedule') as ScanTrigger;
    const st: RunState = {
      runId,
      scope: { connector, scope },
      connectorId: r.connector_id,
      trigger,
      window: { from: iso(r.window_start) ?? this.now().toISOString(), to: iso(r.window_end) ?? this.now().toISOString() },
      skillVersion: r.skill_version ?? undefined,
      staged: [],
    };
    RUNS.set(runId, st);
    return st;
  }

  /** S1: lock the run row and require `running`. */
  protected async mustRunning(tx: DbOrTx, runId: string, lock = true): Promise<void> {
    const res = await tx.execute<{ status: string }>(
      lock ? sql`select status from scan_runs where id = ${runId} for update` : sql`select status from scan_runs where id = ${runId}`,
    );
    const s = res.rows[0]?.status;
    if (!s) throw new RunStateError(`unknown run ${runId}`);
    if (s !== 'running') throw new RunStateError(`run ${runId} is ${s === 'succeeded' ? 'succeeded' : s === 'cancelled' ? 'failed' : s}`);
  }

  protected async mustWork(tx: DbOrTx, id: string): Promise<void> {
    if (!UUID.test(id)) throw new StoreNotFoundError(`work item ${id}`);
    const r = await tx.execute<{ ok: boolean }>(sql`select exists (select 1 from work_items where id = ${id} and owner_user_id = ${this.userId}) as ok`);
    if (!r.rows[0]?.ok) throw new StoreNotFoundError(`work item ${id}`);
  }

  protected async mustSources(tx: DbOrTx, ids: string[]): Promise<void> {
    const bad = ids.find((id) => !UUID.test(id));
    if (bad) throw new StoreNotFoundError(`source item ${bad}`);
    if (!ids.length) return;
    const r = await tx.execute<{ id: string }>(sql`select id from source_items where owner_user_id = ${this.userId} and id = any(${uuidArr(ids)})`);
    const have = new Set(r.rows.map((x) => x.id));
    const missing = ids.find((id) => !have.has(id));
    if (missing) throw new StoreNotFoundError(`source item ${missing}`);
  }

  /** S10: add work items to the scope's durable pending re-evaluation set. */
  protected async markPending(tx: DbOrTx, run: RunState, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const sid = scopeId(run.scope);
    await tx.execute(sql`
      insert into scan_cursors (owner_user_id, connector_id, scope, cursor_kind, cursor_json)
      values (${this.userId}, ${run.connectorId}, ${sid}, 'composite', jsonb_build_object('pending', to_jsonb(${textArr(ids)})))
      on conflict (connector_id, scope) do update set
        cursor_json = jsonb_set(coalesce(scan_cursors.cursor_json, '{}'::jsonb), '{pending}',
          to_jsonb(array(select distinct x from unnest(
            coalesce(array(select jsonb_array_elements_text(scan_cursors.cursor_json->'pending')), '{}'::text[]) || ${textArr(ids)}) as x order by x))),
        updated_at = now()`);
  }

  // ------------------------------------------------------------------ digests

  /** Linkable items (S14): not dismissed/merged; done only within the reopen window. */
  protected async digests(opts: { limit?: number; ids?: string[] } = {}): Promise<OpenItemDigestExt[]> {
    const since = new Date(this.now().getTime() - REOPEN_WINDOW_MS).toISOString();
    const idFilter = opts.ids ? sql`and wi.id = any(${uuidArr(opts.ids)})` : sql``;
    const lim = opts.limit !== undefined ? sql`limit ${opts.limit}` : sql``;
    const res = await this.db.execute<DigestRow>(sql`
      select wi.id, wi.initiative_id, wi.kind, wi.title, wi.purpose, wi.status, wi.resolution, wi.involvement,
             case when wi.resolution = 'handed_off' then coalesce(rp.display_name, rp.primary_email) end as handed_off_to,
             wi.account_id,
             (select array_agg(distinct lower(k)) from (
                select cp.display_name as k from people cp where cp.id = wi.counterparty_person_id
                union all select cp.primary_email from people cp where cp.id = wi.counterparty_person_id
                union all select p.display_name from work_item_links l join people p on p.id = l.person_id where l.work_item_id = wi.id
                union all select p.primary_email from work_item_links l join people p on p.id = l.person_id where l.work_item_id = wi.id
                union all
                select v.k from work_item_evidence e
                  join source_items si on si.id = e.source_item_id
                  cross join lateral (
                        select si.meta->'author' as p
                         where jsonb_typeof(si.meta->'author') = 'object' and coalesce(si.meta->'author'->>'isMe', 'false') <> 'true'
                        union all
                        select x from jsonb_array_elements(case when jsonb_typeof(si.meta->'participants') = 'array' then si.meta->'participants' else '[]'::jsonb end) x
                         where jsonb_typeof(x) = 'object' and coalesce(x->>'isMe', 'false') <> 'true') pp
                  cross join lateral (values (pp.p->>'externalId'), (pp.p->>'email'), (pp.p->>'name')) v(k)
                 where e.work_item_id = wi.id
              ) people where k is not null and k <> '') as people,
             (select array_agg(distinct a) from (
                select wi.account_id::text as a where wi.account_id is not null
                union all
                select coalesce((select ac.id::text from accounts ac
                                   left join account_aliases al on al.account_id = ac.id
                                  where ac.owner_user_id = wi.owner_user_id
                                    and (ac.id::text = h or lower(ac.name) = lower(h) or al.normalized_value = lower(h)) limit 1), h)
                  from work_item_evidence e join source_items si on si.id = e.source_item_id,
                       jsonb_array_elements_text(case when jsonb_typeof(si.meta->'accountHints') = 'array' then si.meta->'accountHints' else '[]'::jsonb end) h
                 where e.work_item_id = wi.id
              ) accts) as accounts,
             (select array_agg(distinct si.external_parent_id) from work_item_evidence e join source_items si on si.id = e.source_item_id
               where e.work_item_id = wi.id and si.external_parent_id is not null) as thread_refs,
             (select array_agg(distinct f) from (
                select r.value as f from work_item_evidence e join source_item_refs r on r.source_item_id = e.source_item_id
                 where e.work_item_id = wi.id and r.kind in ('drive_file', 'url')
                union all select x.external_id from work_item_links l join assets x on x.id = l.asset_id where l.work_item_id = wi.id
                union all select x.external_id from work_item_deliverables dd join assets x on x.id = dd.asset_id where dd.work_item_id = wi.id
              ) files) as file_refs,
             (select max(si.occurred_at) from work_item_evidence e join source_items si on si.id = e.source_item_id where e.work_item_id = wi.id) as last_evidence_at,
             d.expected_file, d.expected_changes, d.id is not null as has_deliverable
        from work_items wi
        left join people rp on rp.id = wi.resolution_person_id
        left join lateral (
              select dd.id, x.external_id as expected_file,
                     (select array_agg(r.description order by r.ordinal) from deliverable_requirements r where r.deliverable_id = dd.id) as expected_changes
                from work_item_deliverables dd left join assets x on x.id = dd.asset_id
               where dd.work_item_id = wi.id and dd.status <> 'abandoned'
               order by dd.created_at desc limit 1) d on true
       where wi.owner_user_id = ${this.userId}
         and wi.status not in ('dismissed', 'merged')
         and (wi.status <> 'done' or coalesce(wi.done_at, wi.status_changed_at) >= ${since}::timestamptz)
         ${idFilter}
       order by last_evidence_at desc nulls last, wi.created_at desc
       ${lim}`);
    return res.rows.map((r) => {
      const d: OpenItemDigestExt = {
        workItemId: r.id,
        initiativeId: r.initiative_id ?? undefined,
        kind: r.kind,
        title: r.title,
        purpose: r.purpose ?? undefined,
        state: r.status,
        people: (r.people ?? []).map(normPerson),
        accounts: r.accounts ?? [],
        keywords: [...new Set([...tokenize(r.title), ...tokenize(r.purpose ?? undefined)])].slice(0, 12),
        threadRefs: r.thread_refs ?? [],
        fileRefs: [...new Set([...(r.file_refs ?? []), ...(r.expected_file ? [r.expected_file] : [])])],
        lastEvidenceAt: iso(r.last_evidence_at),
        involvement: r.involvement,
      };
      if (r.resolution) d.resolution = r.resolution;
      if (r.handed_off_to) d.handedOffTo = r.handed_off_to;
      if (r.has_deliverable) d.expected = { ...(r.expected_file ? { fileId: r.expected_file } : {}), changes: r.expected_changes ?? [] };
      return d;
    });
  }

  protected async initiativeDigests(): Promise<ScanContext['initiatives']> {
    const r = await this.db.execute<{ id: string; title: string; purpose: string | null; accounts: string[] | null }>(sql`
      select i.id, i.title, i.purpose,
             (select array_agg(distinct a) from (
                select i.account_id::text as a where i.account_id is not null
                union all select w.account_id::text from work_items w where w.initiative_id = i.id and w.account_id is not null) x) as accounts
        from initiatives i
       where i.owner_user_id = ${this.userId} and i.status in ('proposed', 'active', 'paused') and i.archived_at is null
       order by i.updated_at desc -- every live initiative (caps audit 2026-11-21: was the newest 200)
    `);
    return r.rows.map((i) => ({
      initiativeId: i.id,
      title: i.title,
      purpose: i.purpose ?? undefined,
      accounts: i.accounts ?? [],
      keywords: [...new Set(tokenize(`${i.title} ${i.purpose ?? ''}`))],
    }));
  }

  protected async aliasAccounts(): Promise<ScanContext['aliases']['accounts']> {
    const r = await this.db.execute<{ id: string; name: string; org62: string | null; aliases: string[] | null }>(sql`
      select a.id, a.name, a.org62_account_id as org62, array_remove(array_agg(distinct al.value), null) as aliases
        from accounts a
        left join account_aliases al on al.account_id = a.id and al.kind in ('name', 'short_name', 'domain')
       where a.owner_user_id = ${this.userId} and a.archived_at is null
       group by a.id, a.name, a.org62_account_id
       order by a.is_my_book desc, a.name -- every account (caps audit 2026-11-21: was 500; the glossary and Org62 IN lists use them all)
    `);
    // `org62:<001…>` lets the Org62 skill build SOQL IN (…) lists (runtime/connectors.ts org62AccountIds).
    return r.rows.map((a) => ({ accountId: a.id, names: [...new Set([a.name, ...(a.aliases ?? []), ...(a.org62 ? [`org62:${a.org62}`] : [])])] }));
  }

  /** D-55: the persona (Settings ▸ Role & rules), read fresh every time: a switch applies to the next plan and run. */
  async persona(): Promise<ResolvedPersona> {
    return loadPersona(this.db, this.userId);
  }

  /** Settings ▸ Scanning (SCAN-SET), read fresh on every context (a change applies to the next run). */
  async scanningPrefs(): Promise<ScanningPrefs> {
    const r = await this.db.execute<{ value: Record<string, unknown> | null }>(sql`
      select value from user_settings where owner_user_id = ${this.userId} and key = 'settings.scanning' limit 1`);
    return scanningPrefsOf(r.rows[0]?.value);
  }

  /** R2: Settings ▸ Closing ▸ Reopen on follow-up, and the reopen window (`reopen.window_days`, default 14). */
  protected async followUpSettings(tx: Tx): Promise<{ reopenOnFollowUp: boolean; windowDays: number }> {
    const closing = await loadClosingSettings(tx, this.userId);
    const r = await tx.execute<{ value: unknown }>(sql`select value from user_settings where owner_user_id = ${this.userId} and key = ${CLOSURE_SETTING_KEYS.reopenWindowDays}`);
    const windowDays = closureSettingsFrom(r.rows[0] ? { [CLOSURE_SETTING_KEYS.reopenWindowDays]: r.rows[0].value } : {}).reopenWindowDays;
    return { reopenOnFollowUp: closing.reopenOnFollowUp, windowDays };
  }

  /** Merged committed ranges (ms) of a scope, optionally only those reaching past `fromMs`. */
  protected async mergedRanges(db: DbOrTx, connectorId: string, sid: string, fromMs?: number): Promise<Range[]> {
    const past = fromMs !== undefined ? sql`and covered_to >= ${isoMs(fromMs)}::timestamptz` : sql``;
    const res = await db.execute<{ l: string; u: string }>(sql`
      select lower(r) as l, upper(r) as u from (
        select unnest(range_agg(covered)) as r from scan_ledger_entries
         where connector_id = ${connectorId} and scope = ${sid} and outcome = 'complete' and covered is not null ${past}) x
       order by 1`);
    return mergeRanges(
      res.rows.map((r) => ({ from: Date.parse(iso(r.l)!), to: Date.parse(iso(r.u)!) })),
      TOL,
    );
  }

  /**
   * Health's error feed (app_events): one open event per (connector, scope, cause), deduped by fingerprint so repeats
   * bump its count and last-seen time. Tripwire hits and cost-cap stops get their own codes. Ids, codes and a redacted,
   * clipped message only.
   */
  protected async failureEvent(tx: DbOrTx, run: RunState, runId: string, error: string, errorClass: ConnectorHealthProbe['errorClass'] | undefined): Promise<void> {
    const sid = scopeId(run.scope);
    const cause = failureCode(error);
    const code = cause === 'prefix_tripwire' || cause === 'cost_cap' ? cause : 'scan_run_failed';
    const label = CONNECTOR_META[run.scope.connector]?.label ?? run.scope.connector;
    const what = code === 'prefix_tripwire' ? 'prompt over the size limit' : code === 'cost_cap' ? 'stopped at its cost cap' : `failed (${cause})`;
    const cls = errorClass === 'config' ? 'validation' : errorClass === 'auth' ? 'auth' : errorClass === 'rate_limited' ? 'rate_limited' : errorClass === 'transient' ? 'transient' : 'unknown';
    const action = code === 'prefix_tripwire' ? 'npm run scan:trace -- <runId> shows the prompt size per pass' : errorClass === 'auth' ? 'Re-auth the connector' : 'npm run scan:trace -- <runId>';
    await tx.execute(sql`
      insert into app_events (owner_user_id, severity, component, code, error_class, message, connector_id, scan_run_id, entity_type, entity_id, detail, fingerprint)
      values (${this.userId}, ${errorClass === 'transient' || errorClass === 'rate_limited' ? 'warn' : 'error'}, ${`scanner.${run.scope.connector}`}, ${code}, ${cls},
              ${`${label} ${sid.slice(run.scope.connector.length + 1)}: ${what}`.slice(0, 200)}, ${run.connectorId}, ${runId}, 'scope', ${sid},
              ${JSON.stringify({ runId, cause, errorClass: errorClass ?? null, error: redact(error).text.slice(0, 160), suggestedAction: action })}::jsonb,
              ${`scanner.${run.scope.connector}|${code}|${sid}|${cause}`})
      on conflict (fingerprint) where resolved_at is null
      do update set occurrence_count = app_events.occurrence_count + 1, last_occurred_at = now(), scan_run_id = excluded.scan_run_id,
                    detail = excluded.detail, message = excluded.message`);
  }

  // ------------------------------------------------------------------ ledger queries

  async getCursor(scope: ScopeKey): Promise<Cursor | null> {
    const connectorId = await this.connectorId(scope.connector);
    const res = await this.db.execute<{ cursor_value: string | null; high_watermark_at: string | null }>(sql`
      select cursor_value, high_watermark_at from scan_cursors where connector_id = ${connectorId} and scope = ${scopeId(scope)}`);
    const r = res.rows[0];
    if (!r?.high_watermark_at) return null;
    return { value: r.cursor_value ?? '', at: iso(r.high_watermark_at)! };
  }

  /** Extension used by reconcile: [first committed coverage start, last committed coverage end] of a scope. */
  async coverageSpan(scope: ScopeKey): Promise<{ from: string; to: string } | null> {
    const connectorId = await this.connectorId(scope.connector);
    const r = await this.db.execute<{ f: string | null; t: string | null }>(sql`
      select min(covered_from) as f, max(covered_to) as t from scan_ledger_entries
       where connector_id = ${connectorId} and scope = ${scopeId(scope)} and outcome = 'complete' and covered is not null and not isempty(covered)`);
    const row = r.rows[0];
    return row?.f && row.t ? { from: iso(row.f)!, to: iso(row.t)! } : null;
  }

  async coverageGaps(scope: ScopeKey, window: TimeWindow): Promise<TimeWindow[]> {
    const connectorId = await this.connectorId(scope.connector);
    const sid = scopeId(scope);
    // Low watermark = earliest committed coverage start, points included (as the memory store's committedRanges).
    const low = await this.db.execute<{ low: string | null }>(sql`
      select min(covered_from) as low from scan_ledger_entries
       where connector_id = ${connectorId} and scope = ${sid} and outcome = 'complete' and covered is not null`);
    if (!low.rows[0]?.low) return [{ ...window }];
    const lowMs = Date.parse(iso(low.rows[0].low)!);
    const from = Math.max(toMs(window.from)!, lowMs);
    const to = toMs(window.to)!;
    if (to <= from) return [];
    const merged = await this.mergedRanges(this.db, connectorId, sid, from - TOL);
    const holes: TimeWindow[] = [];
    let at = from;
    for (const r of merged) {
      if (r.to <= at) continue;
      if (r.from > at + TOL) holes.push({ from: isoMs(at), to: isoMs(Math.min(r.from, to)) });
      at = Math.max(at, r.to);
      if (at >= to) break;
    }
    if (at < to - TOL) holes.push({ from: isoMs(at), to: isoMs(to) });
    return holes.filter((h) => toMs(h.to)! > toMs(h.from)!);
  }

  /**
   * Today's spend vs caps. The app's Settings section `settings.budgets` (legacy key `budgets`) > the llm_budgets
   * `total` row > defaults. A `hard_stop` llm_budgets row can lower the hard cap below the setting; a non-stop row
   * (bootstrap writes one at the soft budget) is the soft budget only (stress finding SET-1).
   */
  async budgetStatus(): Promise<BudgetStatus> {
    const day = localDay(this.now(), await this.timezone());
    const res = await this.db.execute<{ spent: string | null; soft: string | null; hard: string | null; alert: string | null; lim: string | null; stop: boolean | null; lim_alert: string | null; today: { day?: string; softUsd?: number; hardUsd?: number } | null }>(sql`
      with b as (select value from user_settings where owner_user_id = ${this.userId} and key in ('settings.budgets', 'budgets') order by (key = 'settings.budgets') desc limit 1),
           l as (select daily_limit_usd, hard_stop, alert_at_pct from llm_budgets where owner_user_id = ${this.userId} and scope = 'total' limit 1)
      -- BUD-1: the daily cap counts daily spend only; the one-time first-scan budget (B-080) has its own meter.
      select (select coalesce(sum(cost_usd), 0) from llm_calls where owner_user_id = ${this.userId} and budget_day = ${day}::date and budget = 'daily') as spent,
             (select value->>'softUsd' from b) as soft, (select value->>'hardUsd' from b) as hard, (select value->>'alertPct' from b) as alert,
             (select value->'today' from b) as today,
             (select daily_limit_usd from l) as lim, (select hard_stop from l) as stop, (select alert_at_pct from l) as lim_alert`);
    const r = res.rows[0]!;
    // Settings ▸ Budgets ▸ "Today only" wins for its own day (budgetsForDay in the contract).
    const t = r.today && r.today.day === day && typeof r.today.softUsd === 'number' && typeof r.today.hardUsd === 'number' ? r.today : null;
    const softCapUsd = Number(t?.softUsd ?? r.soft ?? (r.lim != null && !r.stop ? r.lim : null) ?? this.o.defaultBudget.softUsd);
    const hardSetting = Number(t?.hardUsd ?? r.hard ?? this.o.defaultBudget.hardUsd);
    const hardCapUsd = r.lim != null && r.stop ? Math.min(hardSetting, Number(r.lim)) : hardSetting;
    const alertPct = Number(r.alert ?? r.lim_alert ?? this.o.defaultBudget.alertPct ?? 80);
    const todayUsd = Number(r.spent ?? 0);
    const state = todayUsd >= hardCapUsd ? 'capped' : softCapUsd > 0 && (todayUsd / softCapUsd) * 100 >= alertPct ? 'soft_alert' : 'ok';
    return { todayUsd, softCapUsd, hardCapUsd, state };
  }
}
