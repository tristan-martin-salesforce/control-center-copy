// DbScannerStore run start, source items, candidates and evidence. Split from store-db.ts (max-lines); the class is still exported from store-db.ts.
import { sql } from 'drizzle-orm';

import { redact, redactDeep } from '@/connectors/redact';
import type { Tx } from '@/db/client';
import { recordNewInfo } from '@/db/queue';
import { sourceItemUrl } from '@/projections/links';
import { trace } from '@/scanner/trace';
import type { CandidateExt, OpenItemDigestExt } from './runtime/contract-ext';
import { deliveryMatch } from './delivery';
import { normDriveRef, NotFoundError as StoreNotFoundError, tokenize, toMs } from './store-memory';
import {
  scopeId, type Candidate, type Confidence, type ConnectorId, type EvidenceRole, type NormalizedSourceItem,
  type ScanContext, type ScanTrigger, type ScopeKey, type TimeWindow,
} from './types';
import {
  isoMs, DAY, TRIGGER_MAP, CONNECTOR_META, modelTierOf, RUNS, type RunState, dbKindOf, splitPayload, EXCERPT_MAX,
  textArr, DRIVE_ID, normPerson, CONFIDENCE_NUM,
} from './store-db.shared';
import { DbScannerStoreBase } from './store-db.base';

/** DbScannerStore's run start, context, source items, candidates and evidence. */
export abstract class DbScannerStoreItems extends DbScannerStoreBase {

  // ------------------------------------------------------------------ context

  async getContext(scope: ScopeKey, opts: { maxOpenItems?: number } = {}): Promise<ScanContext> {
    const now = this.now();
    // 60 by default (the scan pack's budget, src/llm/skill-loader.ts); a caller that needs every open item (the Drive
    // tracker's linked files) passes Infinity (caps audit 2026-11-21: clamped at 1000)
    const max = Math.max(0, opts.maxOpenItems ?? 60);
    const connectorId = await this.connectorId(scope.connector);
    const sid = scopeId(scope);
    const [cursor, me, watch, accounts, channels, items, inits, last, hasCov, scanning, persona] = await Promise.all([
      this.getCursor(scope),
      this.db.execute<{ id: string; name: string; email: string; slack_id: string | null; org62_user_id: string | null }>(sql`
        select u.id, coalesce(u.display_name, p.display_name, u.email) as name, u.email,
               (select pi.external_id from person_identities pi where pi.person_id = u.person_id and pi.system = 'slack'
                 order by pi.is_primary desc limit 1) as slack_id,
               (select pi.external_id from person_identities pi where pi.person_id = u.person_id and pi.system = 'org62_user'
                 order by pi.is_primary desc limit 1) as org62_user_id
          from users u left join people p on p.id = u.person_id
         where u.id = ${this.userId}`),
      this.db.execute<{ kind: string; ref: string | null; label: string }>(sql`
        select w.scope_kind::text as kind,
               coalesce(c.external_id, o.org62_opportunity_id, a.org62_account_id, a.id::text, p.primary_email, p.id::text,
                        i.id::text, w.search_query) as ref,
               w.label
          from watch_subscriptions w
          left join channels c on c.id = w.channel_id
          left join opportunities o on o.id = w.opportunity_id
          left join accounts a on a.id = w.account_id
          left join people p on p.id = w.person_id
          left join initiatives i on i.id = w.initiative_id
         where w.owner_user_id = ${this.userId} and w.enabled
        union all
        select 'channel', c.external_id, coalesce(c.name, c.external_id)
          from channels c
         where c.owner_user_id = ${this.userId} and c.watch_mode = 'digest' and c.archived_at is null
           and not exists (select 1 from watch_subscriptions w where w.channel_id = c.id and w.enabled)`),
      this.aliasAccounts(),
      this.db.execute<{ external_id: string; account_id: string | null; name: string | null }>(sql`
        select c.external_id, m.account_id, c.name
          from channels c
          left join channel_account_maps m on m.channel_id = c.id and m.user_verdict is distinct from 'rejected'
         where c.owner_user_id = ${this.userId} and c.archived_at is null
           and (m.account_id is not null or c.is_customer_channel or c.watch_mode <> 'items') -- every mapped channel (caps audit: was an unordered 500)
      `),
      max > 0 ? this.digests(Number.isFinite(max) ? { limit: max } : {}) : Promise.resolve([]),
      this.initiativeDigests(),
      this.db.execute<{ skill_version: string | null }>(sql`
        select skill_version from scan_runs where connector_id = ${connectorId} and scope = ${sid} and status = 'succeeded'
         order by finished_at desc nulls last limit 1`),
      this.db.execute<{ ok: boolean }>(sql`
        select exists (select 1 from scan_ledger_entries where connector_id = ${connectorId} and scope = ${sid}
                         and outcome = 'complete' and covered is not null) as ok`),
      this.scanningPrefs(),
      this.persona(),
    ]);
    const u = me.rows[0];
    if (!u) throw new StoreNotFoundError(`user ${this.userId}`);
    const gaps = hasCov.rows[0]?.ok ? await this.coverageGaps(scope, { from: isoMs(now.getTime() - 7 * DAY), to: now.toISOString() }) : [];
    return {
      scope,
      cursor,
      gaps,
      me: { userId: u.id, name: u.name, email: u.email, slackId: u.slack_id ?? undefined, org62UserId: u.org62_user_id ?? undefined },
      watchList: watch.rows.filter((w) => w.ref).map((w) => ({ kind: w.kind, ref: w.ref!, label: w.label })),
      aliases: {
        accounts,
        channels: channels.rows.map((c) => ({ channelId: c.external_id, accountId: c.account_id ?? undefined, label: c.name ?? undefined })),
      },
      openItems: items,
      initiatives: inits,
      skillVersion: last.rows[0]?.skill_version ?? '',
      scanning,
      persona,
    };
  }

  // ------------------------------------------------------------------ runs

  async startRun(input: {
    scope: ScopeKey;
    trigger: ScanTrigger;
    window: TimeWindow;
    model?: string;
    skillVersion?: string;
    /** BE-1a extension: the job that runs this scan (scan_runs.job_id). */
    jobId?: number | string;
  }): Promise<{ runId: string }> {
    const { scope } = input;
    if (toMs(input.window.from) == null || toMs(input.window.to) == null) throw new RangeError('startRun: invalid window');
    const connectorId = await this.connectorId(scope.connector);
    const cursor = await this.getCursor(scope);
    const mode = input.trigger === 'reconcile' ? 'reconcile' : input.trigger === 'catch_up' ? 'backfill' : 'incremental';
    const runId = await this.cs(
      scope.connector,
      `scan ${scopeId(scope)} started`,
      async (tx) => {
        // Health "Rescan" inserts a queued placeholder run for the job it enqueues, so the UI has a run to show at
        // once. The job's first run adopts that row (queued → running → done): one run, not a placeholder that
        // never finishes next to the real one (BE-CHAT hole; stress finding W-1).
        if (input.jobId !== undefined && input.jobId !== null) {
          const adopted = await tx.execute<{ id: string }>(sql`
            update scan_runs set scope = ${scopeId(scope)}, trigger = ${TRIGGER_MAP[input.trigger]}, mode = ${mode}, status = 'running',
                   window_start = ${isoMs(toMs(input.window.from)!)}::timestamptz, window_end = ${isoMs(toMs(input.window.to)!)}::timestamptz,
                   skill_key = ${CONNECTOR_META[scope.connector]?.skill ?? null}, skill_version = ${input.skillVersion ?? null},
                   model_tier = ${modelTierOf(input.model)}, cursor_before = ${JSON.stringify(cursor ? { at: cursor.at } : null)}::jsonb,
                   started_at = ${this.now().toISOString()}::timestamptz, error_code = null, error_message = null
             where id = (select id from scan_runs where owner_user_id = ${this.userId} and connector_id = ${connectorId}
                            and job_id = ${Number(input.jobId)} and status = 'queued' order by created_at limit 1 for update)
            returning id`);
          if (adopted.rows[0]) return adopted.rows[0].id;
        }
        const res = await tx.execute<{ id: string }>(sql`
          insert into scan_runs (owner_user_id, connector_id, scope, trigger, mode, status, window_start, window_end, job_id,
                                 skill_key, skill_version, model_tier, cursor_before, started_at)
          values (${this.userId}, ${connectorId}, ${scopeId(scope)}, ${TRIGGER_MAP[input.trigger]}, ${mode}, 'running',
                  ${isoMs(toMs(input.window.from)!)}::timestamptz, ${isoMs(toMs(input.window.to)!)}::timestamptz,
                  ${input.jobId === undefined || input.jobId === null ? null : Number(input.jobId)},
                  ${CONNECTOR_META[scope.connector]?.skill ?? null}, ${input.skillVersion ?? null}, ${modelTierOf(input.model)},
                  ${JSON.stringify(cursor ? { at: cursor.at } : null)}::jsonb, ${this.now().toISOString()}::timestamptz)
          returning id`);
        return res.rows[0]!.id;
      },
      false,
    );
    RUNS.set(runId, { runId, scope, connectorId, trigger: input.trigger, window: { ...input.window }, skillVersion: input.skillVersion, model: input.model, staged: [] });
    return { runId };
  }

  async recordSourceItems(
    runId: string,
    items: NormalizedSourceItem[],
  ): Promise<Array<{ sourceItemId: string; dedupeKey: string; isNew: boolean; changed: boolean }>> {
    const run = await this.run(runId);
    for (const it of items) {
      if (!it.dedupeKey || !it.contentHash || !it.externalId) throw new RangeError('recordSourceItems: dedupeKey, contentHash and externalId are required');
      const watchOk = run.scope.connector === 'watch' && (it.connector === 'slack' || it.connector === 'org62');
      if (it.connector !== run.scope.connector && !watchOk) throw new RangeError(`recordSourceItems: item connector ${it.connector} ≠ run connector ${run.scope.connector}`);
      if (toMs(it.occurredAt) == null) throw new RangeError(`recordSourceItems: ${it.dedupeKey} occurredAt is not a timestamp`);
    }
    const connectorIds = new Map<ConnectorId, string>();
    for (const c of new Set(items.map((i) => i.connector))) connectorIds.set(c, c === run.scope.connector ? run.connectorId : await this.connectorId(c));
    const rows = await this.cs(
      run.scope.connector,
      `ingest ${items.length} item(s) from ${scopeId(run.scope)}`,
      async (tx) => {
        await this.mustRunning(tx, runId);
        const rows: Array<{ sourceItemId: string; dedupeKey: string; isNew: boolean; changed: boolean }> = [];
        for (const it of items) rows.push(await this.upsertItem(tx, run, it, connectorIds.get(it.connector)!));
        return rows;
      },
      false,
    );
    // AUDIT: which source items this run saw (new / changed / unchanged), so "was it fetched?" has an answer.
    trace(runId, 'recorded', () => ({ n: rows.length, new: rows.filter((r) => r.isNew).length, changed: rows.filter((r) => r.changed).length, ids: rows.map((r) => r.sourceItemId), newIds: rows.filter((r) => r.isNew).map((r) => r.sourceItemId) }));
    return rows;
  }

  protected async upsertItem(
    tx: Tx,
    run: RunState,
    it: NormalizedSourceItem,
    connectorId: string,
  ): Promise<{ sourceItemId: string; dedupeKey: string; isNew: boolean; changed: boolean }> {
    const { source, kind } = dbKindOf(it);
    const { meta: rawMeta, text } = splitPayload(it.payload);
    const metaDeep = redactDeep({
      ...rawMeta,
      itemKind: it.kind,
      connector: it.connector,
      threadRef: it.threadRef,
      fileRefs: it.fileRefs,
      accountHints: it.accountHints,
      oppHints: it.oppHints,
      author: it.author ? { name: it.author.name, email: it.author.email, externalId: it.author.externalId, isMe: it.author.isMe, isExternal: it.author.isExternal } : undefined,
      participants: it.participants?.slice(0, 50),
    });
    // R6: excerpts keep up to 4,000 chars (an ask past character 1,000 was lost, SCN-9); prompts clip per use.
    const excerpt = (it.excerpt ?? '').slice(0, EXCERPT_MAX);
    const bodyRaw = text.length ? [excerpt && !text.some((t) => t.includes(excerpt)) ? excerpt : '', ...text].filter(Boolean).join('\n\n') : excerpt;
    const body = redact(bodyRaw.slice(0, 60_000));
    const title = redact(it.title ?? '');
    const own = body.count + title.count;
    const redactionCount = own + (metaDeep.redacted ? 1 : 0) + (it.redacted && own === 0 && !metaDeep.redacted ? 1 : 0);
    const kinds = [...new Set([...body.kinds, ...title.kinds, ...(redactionCount > own ? ['upstream'] : [])])];
    const fromMe = it.author?.isMe === true;
    const p = it.payload ?? {};
    const toMe = (it.participants ?? []).some((x) => x.isMe) || p.toMe === true || p.ccMe === true || p.mentionsMe === true;
    const occurred = isoMs(toMs(it.occurredAt)!);
    const actorPersonId = await this.actorPerson(tx, it);
    // Provenance: a deep link on every item. Org62 rows and Claude sessions carry no permalink of their own (links.ts).
    const url = it.permalink ?? sourceItemUrl({ source, externalId: it.externalId, meta: { ...rawMeta, oppHints: it.oppHints } });
    const res = await tx.execute<{ id: string; inserted: boolean; written: boolean }>(sql`
      with ins as (
        insert into source_items as s
               (owner_user_id, connector_id, source, kind, external_id, external_parent_id, external_container_id, dedupe_key,
                content_hash, occurred_at, actor_external_id, actor_person_id, from_me, addressed_to_me, title, url, body, body_format,
                body_expires_at, redacted, redaction_count, redaction_kinds, meta, first_scan_run_id, last_scan_run_id)
        values (${this.userId}, ${connectorId}, ${source}, ${kind}, ${it.externalId}, ${it.threadRef ?? null},
                ${run.scope.scope}, ${it.dedupeKey}, ${it.contentHash}, ${occurred}::timestamptz,
                ${it.author?.email ?? it.author?.externalId ?? null}, (select p.id from people p where p.id = ${actorPersonId}::uuid), ${fromMe}, ${toMe && !fromMe},
                ${title.text || null}, ${url}, ${body.text || null}, 'plain',
                ${occurred}::timestamptz + interval '90 days', ${redactionCount > 0}, ${redactionCount}, ${textArr(kinds)},
                ${JSON.stringify(metaDeep.value)}::jsonb, ${run.runId}, ${run.runId})
        on conflict (owner_user_id, dedupe_key) do update set
               content_hash       = excluded.content_hash,
               title              = excluded.title,
               url                = excluded.url,
               body               = case when s.body_purged_at is null then excluded.body end,
               meta               = excluded.meta,
               external_parent_id = excluded.external_parent_id,
               actor_external_id  = excluded.actor_external_id,
               actor_person_id    = coalesce(excluded.actor_person_id, s.actor_person_id),
               from_me            = excluded.from_me,
               addressed_to_me    = excluded.addressed_to_me,
               redacted           = excluded.redacted,
               redaction_count    = excluded.redaction_count,
               redaction_kinds    = excluded.redaction_kinds,
               revision           = s.revision + 1,
               content_changed_at = now(),
               last_seen_at       = now(),
               last_scan_run_id   = excluded.last_scan_run_id
         where s.content_hash is distinct from excluded.content_hash
        returning s.id, (s.xmax = 0) as inserted
      )
      select id, inserted, true as written from ins
      union all
      select id, false, false from source_items
       where owner_user_id = ${this.userId} and dedupe_key = ${it.dedupeKey} and not exists (select 1 from ins)`);
    const row = res.rows[0]!;
    // PPL-1: an unchanged row recorded before the author was known gets the person now.
    if (!row.written && actorPersonId) await tx.execute(sql`update source_items set actor_person_id = (select p.id from people p where p.id = ${actorPersonId}::uuid) where id = ${row.id} and actor_person_id is null`);
    if (row.written && it.fileRefs?.length) {
      // RED-1: a ref that redaction would change (a password-manager share link) is a credential: never stored as a ref.
      for (const raw of it.fileRefs.slice(0, 30).filter((r) => !redact(r).redacted)) {
        // R13: `drive:<ID>` and Docs/Drive URLs are stored as the bare id (kind drive_file), so every "same file" join
        // matches (before, `drive:<ID>` landed as a url and workItemsByFile missed it). Migration 0029 fixes old rows.
        const ref = normDriveRef(raw);
        await tx.execute(sql`
          insert into source_item_refs (source_item_id, kind, value)
          values (${row.id}, ${DRIVE_ID.test(ref) ? 'drive_file' : 'url'}, ${ref})
          on conflict (source_item_id, kind, value) do nothing`);
      }
    }
    return { sourceItemId: row.id, dedupeKey: it.dedupeKey, isNew: row.inserted, changed: row.written && !row.inserted };
  }

  /**
   * PPL-1: the person behind a source item's author. Me for my own items; otherwise a known identity (Slack user id,
   * then email) or a directory email. A Slack author nobody knows yet gets a person row (hidden from the directory, like
   * any referenced person outside it: `synthetic`) with the Slack identity, so asks, replies and the completion pass can
   * tell people apart. Before, `actor_person_id` was empty on every Slack source item.
   */
  protected async actorPerson(tx: Tx, it: NormalizedSourceItem): Promise<string | null> {
    const a = it.author;
    if (!a) return null;
    if (a.isMe) {
      const hit = this.persons.get('me');
      if (hit) return hit;
      const r = await tx.execute<{ id: string | null }>(sql`select person_id as id from users where id = ${this.userId}`);
      const id = r.rows[0]?.id ?? null;
      if (id) this.persons.set('me', id);
      return id;
    }
    const slack = it.connector === 'slack' && a.externalId && /^[UW][A-Z0-9]{6,}$/.test(a.externalId) ? a.externalId : undefined;
    const email = a.email && /@/.test(a.email) ? a.email.trim().toLowerCase() : undefined;
    const keys = [...(slack ? [`slack:${slack}`] : []), ...(email ? [`email:${email}`] : [])];
    if (!keys.length) return null;
    for (const k of keys) {
      const hit = this.persons.get(k);
      if (hit) return hit;
    }
    const missAt = this.noPerson.get(keys.join('|'));
    if (!slack && missAt !== undefined && Date.now() - missAt < 10 * 60_000) return null;
    const found = await tx.execute<{ id: string; sys: string }>(sql`
      select pi.person_id as id, pi.system::text as sys from person_identities pi join people p on p.id = pi.person_id
       where pi.owner_user_id = ${this.userId} and p.merged_into_person_id is null
         and ((pi.system = 'slack' and pi.external_id = ${slack ?? ''}) or (pi.system = 'email' and lower(pi.external_id) = ${email ?? ''}))
      union all
      select p.id, 'directory' from people p
       where p.owner_user_id = ${this.userId} and p.merged_into_person_id is null and ${email ?? ''} <> '' and lower(p.primary_email) = ${email ?? ''}
       order by 2 desc limit 1`);
    let id = found.rows[0]?.id ?? null;
    if (id && slack && found.rows[0]!.sys !== 'slack') {
      await tx.execute(sql`
        insert into person_identities (owner_user_id, person_id, system, external_id, method, confidence)
        values (${this.userId}, ${id}::uuid, 'slack', ${slack}, 'connector', 1) on conflict do nothing`);
    }
    if (!id && slack && a.name?.trim()) {
      const name = redact(a.name.trim()).text.slice(0, 120);
      const created = await tx.execute<{ id: string }>(sql`
        insert into people (owner_user_id, display_name, primary_email, affiliation)
        values (${this.userId}, ${name}, ${email ?? null}, ${a.isExternal ? 'customer' : 'unknown'}) returning id`);
      const pid = created.rows[0]!.id;
      const ident = await tx.execute<{ person_id: string }>(sql`
        insert into person_identities (owner_user_id, person_id, system, external_id, method, confidence)
        values (${this.userId}, ${pid}::uuid, 'slack', ${slack}, 'connector', 1)
        on conflict (owner_user_id, system, external_id) do nothing returning person_id`);
      if (ident.rows[0]) {
        if (email) {
          await tx.execute(sql`
            insert into person_identities (owner_user_id, person_id, system, external_id, method, confidence)
            values (${this.userId}, ${pid}::uuid, 'email', ${email}, 'connector', 1) on conflict do nothing`);
        }
        await tx.execute(sql`
          insert into user_settings (owner_user_id, key, value) values (${this.userId}, ${`cc.ext/people/${pid}`}, ${JSON.stringify({ synthetic: true })}::jsonb)
          on conflict do nothing`);
        id = pid;
      } else {
        // Someone else created it meanwhile: use theirs, drop ours.
        await tx.execute(sql`delete from people where id = ${pid}::uuid`);
        const r = await tx.execute<{ id: string }>(sql`select person_id as id from person_identities where owner_user_id = ${this.userId} and system = 'slack' and external_id = ${slack}`);
        id = r.rows[0]?.id ?? null;
      }
    }
    if (id) for (const k of keys) this.persons.set(k, id);
    else this.noPerson.set(keys.join('|'), Date.now());
    return id;
  }

  // ------------------------------------------------------------------ linking

  async findCandidates(q: {
    text?: string;
    people?: string[];
    accounts?: string[];
    threadRefs?: string[];
    fileRefs?: string[];
    limit?: number;
  }): Promise<Candidate[]> {
    const tokens = new Set(tokenize(q.text));
    const people = new Set((q.people ?? []).map(normPerson).filter(Boolean));
    const threads = new Set(q.threadRefs ?? []);
    const files = new Set((q.fileRefs ?? []).map(normDriveRef));
    const launched = new Set([...threads].filter((t) => t.startsWith('cc:')).map((t) => t.slice(3)));
    const aliases = people.size || q.accounts?.length ? await this.aliasAccounts() : [];
    const resolve = (hints: string[]) =>
      [
        ...new Set(
          hints.map((h) => {
            const lower = h.toLowerCase();
            return aliases.find((a) => a.accountId === h || a.names.some((n) => n.toLowerCase() === lower))?.accountId ?? h;
          }),
        ),
      ];
    const accounts = new Set(resolve(q.accounts ?? []));
    const [pool, inits] = await Promise.all([this.digests(), tokens.size || accounts.size ? this.initiativeDigests() : Promise.resolve([])]);
    const out: CandidateExt[] = [];
    const ext = (w: OpenItemDigestExt) => ({ state: w.state, ...(w.resolution ? { resolution: w.resolution } : {}), ...(w.involvement ? { involvement: w.involvement } : {}) });
    for (const w of pool) {
      if (launched.has(w.workItemId)) {
        out.push({ workItemId: w.workItemId, initiativeId: w.initiativeId, title: w.title, score: 1, why: 'same thread; launched from this item', ...ext(w) });
        continue;
      }
      let score = 0;
      const why: string[] = [];
      if (w.threadRefs.some((t) => threads.has(t))) {
        score += 0.6;
        why.push('same thread');
      }
      if (w.fileRefs.some((f) => files.has(normDriveRef(f)))) {
        score += 0.5;
        why.push('same file');
      }
      const pHits = [...people].filter((p) => w.people.some((wp) => wp === p || wp.includes(p) || p.includes(wp)));
      if (pHits.length) {
        score += Math.min(0.3, 0.15 * pHits.length);
        why.push(`people: ${pHits.slice(0, 3).join(', ')}`);
      }
      const aHits = [...accounts].filter((a) => w.accounts.includes(a));
      if (aHits.length) {
        score += 0.25;
        why.push(`account: ${aHits[0]}`);
      }
      const itemTokens = new Set([...w.keywords, ...tokenize(w.title), ...tokenize(w.purpose)]);
      const kHits = [...tokens].filter((t) => itemTokens.has(t));
      if (kHits.length) {
        score += Math.min(0.35, (0.35 * kHits.length) / Math.max(2, Math.min(tokens.size, itemTokens.size)));
        why.push(`keywords: ${kHits.slice(0, 4).join(', ')}`);
      }
      if (score >= 0.15) out.push({ workItemId: w.workItemId, initiativeId: w.initiativeId, title: w.title, score: Math.min(1, Math.round(score * 100) / 100), why: why.join('; '), ...ext(w) });
    }
    for (const i of inits) {
      let score = 0;
      const why: string[] = [];
      const aHits = [...accounts].filter((a) => i.accounts.includes(a));
      if (aHits.length) {
        score += 0.3;
        why.push(`account: ${aHits[0]}`);
      }
      const it = new Set([...i.keywords, ...tokenize(i.title), ...tokenize(i.purpose)]);
      const kHits = [...tokens].filter((t) => it.has(t));
      if (kHits.length) {
        score += Math.min(0.4, (0.4 * kHits.length) / Math.max(2, Math.min(tokens.size, it.size)));
        why.push(`keywords: ${kHits.slice(0, 4).join(', ')}`);
      }
      if (score >= 0.2) out.push({ initiativeId: i.initiativeId, title: i.title, score: Math.min(1, Math.round(score * 100) / 100), why: why.join('; ') });
    }
    return out
      .sort((a, b) => b.score - a.score || (a.workItemId ?? a.initiativeId ?? '').localeCompare(b.workItemId ?? b.initiativeId ?? ''))
      .slice(0, q.limit ?? 5);
  }

  async linkEvidence(
    runId: string,
    input: { workItemId: string; sourceItemId: string; role: EvidenceRole; confidence: Confidence; reason: string },
  ): Promise<{ evidenceId: string; touchedWorkItemId: string }> {
    const run = await this.run(runId);
    const extractorId = await this.extractorId(run.scope.connector, run.skillVersion, run.model);
    const evidenceId = await this.cs(run.scope.connector, `link evidence (${input.role})`, async (tx) => {
      await this.mustRunning(tx, runId);
      await this.mustWork(tx, input.workItemId);
      await this.mustSources(tx, [input.sourceItemId]);
      let { confidence, reason } = input;
      if (input.role === 'completion' && confidence !== 'sure') {
        const what = await this.deliveredWith(tx, input.workItemId, input.sourceItemId);
        if (what) {
          confidence = 'sure';
          reason = `delivered_with_attachment: ${what}; ${reason}`;
        }
      }
      const { id } = await this.addEvidence(tx, run, input.workItemId, input.sourceItemId, input.role, confidence, reason, extractorId);
      return id;
    });
    trace(runId, 'link', { evidenceId, role: input.role, confidence: input.confidence, reason: input.reason }, { sourceItemId: input.sourceItemId, workItemId: input.workItemId });
    return { evidenceId, touchedWorkItemId: input.workItemId };
  }

  /**
   * DLV-1: a completion is Sure when it is my Slack reply in the ask's own DM or thread, after the ask, carrying the
   * file or link the item asks for (src/scanner/delivery.ts). "here you go" plus the zip closes the item; the same
   * words alone stay Likely (a confirm click).
   */
  protected async deliveredWith(tx: Tx, workItemId: string, sourceItemId: string): Promise<string | null> {
    const r = await tx.execute<{ title: string; purpose: string | null; meta: Record<string, unknown>; body: string | null; occurred: string; same: boolean }>(sql`
      select w.title, w.purpose, s.meta, s.body, s.occurred_at as occurred,
             exists (
               select 1 from work_item_evidence e join source_items o on o.id = e.source_item_id
                where e.work_item_id = w.id and e.role = 'origin' and o.source = 'slack' and o.occurred_at < s.occurred_at
                  and (o.external_parent_id = s.external_parent_id
                       or (o.meta->>'channelId' = s.meta->>'channelId' and coalesce(s.meta->>'channelType', '') in ('im', 'mpim')))) as same
        from work_items w, source_items s
       where w.id = ${workItemId} and s.id = ${sourceItemId} and s.source = 'slack' and s.from_me`);
    const row = r.rows[0];
    if (!row?.same) return null;
    const m = row.meta ?? {};
    const files = Array.isArray(m.files) ? (m.files as { name?: string; mimetype?: string }[]) : [];
    const urls = [...String(row.body ?? '').matchAll(/https?:\/\/[^\s|>)]+/g)].map((x) => x[0]);
    return deliveryMatch({ title: row.title, purpose: row.purpose }, { files, hasFile: m.hasFile === true, urls });
  }

  /** S3 + S10: one evidence row per (item, source, role); new rows join the pending set and get the W2 bump. */
  protected async addEvidence(
    tx: Tx,
    run: RunState,
    workItemId: string,
    sourceItemId: string,
    role: EvidenceRole,
    confidence: Confidence,
    reason: string,
    extractorId: string,
  ): Promise<{ id: string; created: boolean }> {
    const ins = await tx.execute<{ id: string }>(sql`
      insert into work_item_evidence (work_item_id, source_item_id, role, confidence, extractor_id, rationale, created_by)
      values (${workItemId}, ${sourceItemId}, ${role}, ${CONFIDENCE_NUM[confidence] ?? 0.5}, ${extractorId},
              ${redact(reason ?? '').text.slice(0, 1000)}, 'connector')
      on conflict on constraint work_item_evidence_target_uq do nothing
      returning id`);
    const id = ins.rows[0]?.id;
    if (!id) {
      const ex = await tx.execute<{ id: string }>(sql`
        select id from work_item_evidence where work_item_id = ${workItemId} and source_item_id = ${sourceItemId} and role = ${role}`);
      return { id: ex.rows[0]!.id, created: false };
    }
    await this.markPending(tx, run, [workItemId]);
    // Save first, then re-evaluate asynchronously (W2). Context-only evidence (hand-offs) does not bump the item.
    if (role !== 'context') await recordNewInfo(tx, workItemId);
    await tx.execute(sql`
      update reconcile_findings set status = 'resolved', resolved_at = now(), resolution_note = 'linked', updated_at = now()
       where owner_user_id = ${this.userId} and source_item_id = ${sourceItemId} and kind = 'unlinked_item' and status = 'open'`);
    return { id, created: true };
  }
}
