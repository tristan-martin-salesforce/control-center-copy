/**
 * ScannerStore conformance suite (SCANNER.md §3, §5, §8; store rules S1–S18 in src/scanner/store-memory.ts).
 * Store-agnostic: the DB store (BE-1a) and the memory store (BE-2a) run the same scenarios through a small harness.
 *
 *   import { runScannerStoreConformance } from './store-conformance';
 *   runScannerStoreConformance('InMemoryScannerStore', makeMemoryHarness);
 *
 * Every scenario uses its own scope (random suffix), so a suite can share one database. Windows are explicit
 * ISO times in the past; only the "done within 14 days" rule depends on the store clock.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ConnectorId, CoverageObject, EvidenceRole, NormalizedSourceItem, ScannerStore, ScopeKey } from '@/scanner/types';
import type { UnlinkedSourceItemDetail } from '@/scanner/runtime/contract-ext';

export interface SeedWorkItemInput {
  title: string;
  kind?: 'task' | 'commitment' | 'ask' | 'training';
  status?: 'open' | 'in_progress' | 'done' | 'suggested' | 'dismissed';
  purpose?: string;
  resolution?: 'done_by_me' | 'handed_off' | 'done_by_other';
  involvement?: 'owner' | 'contributor' | 'watcher' | 'not_involved';
  accountId?: string;
  initiativeId?: string;
  counterparty?: { name: string; email?: string };
  /** ISO; defaults to now when status is done. */
  doneAt?: string;
}

export interface ConformanceHarness {
  store: ScannerStore;
  /** Adds an account the store's alias map knows (accountId + names). */
  seedAccount(input: { name: string; aliases?: string[] }): Promise<string>;
  seedInitiative(input: { title: string; purpose: string; accountId?: string }): Promise<string>;
  seedWorkItem(input: SeedWorkItemInput): Promise<string>;
  /** Current status + title (null when missing). */
  workItem(id: string): Promise<{ status: string; title: string } | null>;
  /** Evidence rows in creation order. */
  evidence(workItemId: string): Promise<Array<{ sourceItemId: string; role: EvidenceRole }>>;
  /** Number of stored source items with this dedupe key (idempotency). */
  countSourceItems(dedupeKey: string): Promise<number>;
  close(): Promise<void>;
}

const sfx = () => randomUUID().slice(0, 8);
const T = (s: string) => new Date(s).toISOString();
const H = 3600_000;

export function item(over: Partial<NormalizedSourceItem> & { connector: ConnectorId; externalId: string }): NormalizedSourceItem {
  return {
    kind: over.connector === 'gmail' ? 'email' : over.connector === 'drive' ? 'file_revision' : 'message',
    dedupeKey: `${over.connector}:${over.externalId}`,
    contentHash: `h-${over.externalId}`,
    occurredAt: T('2026-10-30T10:00:00Z'),
    ...over,
  } as NormalizedSourceItem;
}

const range = (ref: string, from: string, to: string, kind: CoverageObject['kind'] = 'channel_range'): CoverageObject => ({ kind, ref, from: T(from), to: T(to) });
const stats = (fetched = 0) => ({ fetched, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, costUsd: 0 });

export function runScannerStoreConformance(name: string, make: () => Promise<ConformanceHarness>): void {
  describe(`ScannerStore conformance: ${name}`, () => {
    let h: ConformanceHarness;
    let s: ScannerStore;
    beforeAll(async () => {
      h = await make();
      s = h.store;
    });
    afterAll(async () => h?.close());

    const newScope = (connector: ConnectorId = 'slack'): ScopeKey => ({ connector, scope: `channel:C${sfx()}` });
    const start = (scope: ScopeKey, from = '2026-10-30T09:00:00Z', to = '2026-10-30T10:00:00Z', trigger: 'schedule' | 'catch_up' | 'reconcile' = 'schedule') =>
      s.startRun({ scope, trigger, window: { from: T(from), to: T(to) } }).then((r) => r.runId);

    /** One complete page: start, record, cover, finish. */
    async function page(scope: ScopeKey, window: { from: string; to: string }, items: NormalizedSourceItem[], opts: { trigger?: 'schedule' | 'catch_up'; cover?: CoverageObject[]; cursorAt?: string } = {}) {
      const runId = await start(scope, window.from, window.to, opts.trigger);
      const recorded = await s.recordSourceItems(runId, items);
      await s.reportCoverage(runId, opts.cover ?? [range(scope.scope, window.from, window.to)]);
      const fin = await s.finishRun(runId, { cursor: { value: `pos:${opts.cursorAt ?? window.to}`, at: T(opts.cursorAt ?? window.to) }, stats: stats(items.length) });
      return { runId, recorded, ...fin };
    }

    describe('runs (S1, S2, S16)', () => {
      it('only a running run accepts writes', async () => {
        const scope = newScope();
        const done = await page(scope, { from: '2026-10-30T08:00:00Z', to: '2026-10-30T09:00:00Z' }, []);
        await expect(s.recordSourceItems(done.runId, [item({ connector: 'slack', externalId: `late-${sfx()}` })])).rejects.toThrow(/run/i);
        await expect(s.reportCoverage(done.runId, [range(scope.scope, '2026-10-30T09:00:00Z', '2026-10-30T10:00:00Z')])).rejects.toThrow(/run/i);
        await expect(s.finishRun(done.runId, { cursor: { value: 'x', at: T('2026-10-30T09:00:00Z') }, stats: stats() })).rejects.toThrow(/run/i);
        await expect(s.recordSourceItems('run_does_not_exist', [])).rejects.toThrow(/run/i);
        await s.failRun(done.runId, { error: 'late failRun is a no-op' }); // idempotent on a finished run
      });

      it("rejects an item whose connector differs from the run's (watch runs may record slack/org62)", async () => {
        const g = await start(newScope('gmail'));
        await expect(s.recordSourceItems(g, [item({ connector: 'slack', externalId: `x-${sfx()}` })])).rejects.toThrow(/connector/i);
        const w = await start({ connector: 'watch', scope: `slack:channel:C${sfx()}` });
        const [r] = await s.recordSourceItems(w, [item({ connector: 'slack', externalId: `w-${sfx()}` })]);
        expect(r!.isNew).toBe(true);
        await s.failRun(g, { error: 'test end' });
        await s.failRun(w, { error: 'test end' });
      });
    });

    describe('context (S14, S15)', () => {
      it('returns me, a null cursor for a new scope, and a digest with resolution, involvement and people', async () => {
        const scope = newScope();
        const acct = await h.seedAccount({ name: `ACME ${sfx()}`, aliases: ['acme-corp'] });
        const ini = await h.seedInitiative({ title: `ACME headless demo ${sfx()}`, purpose: 'Phase 2 demo', accountId: acct });
        const open = await h.seedWorkItem({ title: 'Prepare workshop agenda', accountId: acct, initiativeId: ini, counterparty: { name: 'AE One', email: 'ae.one@example.com' } });
        const handed = await h.seedWorkItem({ title: 'Send pricing follow-up', status: 'done', resolution: 'handed_off', involvement: 'watcher' });
        const old = await h.seedWorkItem({ title: 'Old done thing', status: 'done', doneAt: new Date(Date.now() - 20 * 24 * H).toISOString() });
        const dismissed = await h.seedWorkItem({ title: 'Dismissed thing', status: 'dismissed' });
        const ctx = await s.getContext(scope, { maxOpenItems: 1000 });
        expect(ctx.cursor).toBeNull();
        expect(ctx.gaps).toEqual([]);
        expect(ctx.scope).toEqual(scope);
        expect(ctx.me.userId).toBeTruthy();
        const d = ctx.openItems.find((o) => o.workItemId === open)!;
        expect(d).toMatchObject({ title: 'Prepare workshop agenda', state: 'open', initiativeId: ini });
        expect(d.accounts).toContain(acct);
        expect(d.people).toEqual(expect.arrayContaining(['ae one']));
        const ho = ctx.openItems.find((o) => o.workItemId === handed)!;
        expect(ho).toMatchObject({ state: 'done', resolution: 'handed_off', involvement: 'watcher' });
        expect(ctx.openItems.some((o) => o.workItemId === old)).toBe(false); // done > 14 days ago
        expect(ctx.openItems.some((o) => o.workItemId === dismissed)).toBe(false);
        expect(ctx.initiatives.find((i) => i.initiativeId === ini)).toBeTruthy();
        expect(ctx.aliases.accounts.find((a) => a.accountId === acct)?.names).toEqual(expect.arrayContaining(['acme-corp']));
        expect(typeof ctx.skillVersion).toBe('string');
        expect((await s.getContext(scope, { maxOpenItems: 0 })).openItems).toEqual([]);
        // caps audit: Infinity is every open item (the Drive tracker's linked files), never a clamp at 1000
        const all = await s.getContext(scope, { maxOpenItems: Number.POSITIVE_INFINITY });
        expect(all.openItems.length).toBe(ctx.openItems.length);
        expect(all.openItems.some((o) => o.workItemId === open)).toBe(true);
      });

      it('exposes deliverable expectations, and skillVersion of the latest succeeded run', async () => {
        const scope = newScope('drive');
        const runId = (await s.startRun({ scope, trigger: 'schedule', window: { from: T('2026-10-30T09:00:00Z'), to: T('2026-10-30T10:00:00Z') }, skillVersion: '7' })).runId;
        const [src] = await s.recordSourceItems(runId, [item({ connector: 'drive', externalId: `ask-${sfx()}` })]);
        const fileId = `1DeckFileId${sfx()}${sfx()}`;
        const { workItemId } = await s.proposeItem(runId, {
          kind: 'deliverable',
          title: 'Update the ACME deck with pricing',
          expected: { fileId, changes: ['add pricing slide', 'fix logo'] },
          evidence: [{ sourceItemId: src!.sourceItemId, role: 'origin', reason: 'asked in Slack' }],
          confidence: 'sure',
        });
        await s.reportCoverage(runId, [range('drive:feed', '2026-10-30T09:00:00Z', '2026-10-30T10:00:00Z', 'query_window')]);
        await s.finishRun(runId, { cursor: { value: 'd', at: T('2026-10-30T10:00:00Z') }, stats: stats(1) });
        const ctx = await s.getContext(scope, { maxOpenItems: 1000 });
        const d = ctx.openItems.find((o) => o.workItemId === workItemId) as (typeof ctx.openItems)[number] & { expected?: unknown };
        expect(d.expected).toEqual({ fileId, changes: ['add pricing slide', 'fix logo'] });
        expect(d.fileRefs).toContain(fileId);
        expect(ctx.skillVersion).toBe('7');
        expect(ctx.cursor?.at).toBe(T('2026-10-30T10:00:00Z'));
      });
    });

    describe('idempotent ingest (S2)', () => {
      it('running the same window twice gives zero new rows; an edit is changed', async () => {
        const scope = newScope();
        const items = [item({ connector: 'slack', externalId: `m1-${sfx()}` }), item({ connector: 'slack', externalId: `m2-${sfx()}` })];
        const a = await page(scope, { from: '2026-10-30T08:00:00Z', to: '2026-10-30T09:00:00Z' }, items);
        expect(a.recorded.map((r) => r.isNew)).toEqual([true, true]);
        const b = await page(scope, { from: '2026-10-30T09:00:00Z', to: '2026-10-30T10:00:00Z' }, items);
        expect(b.recorded.every((r) => !r.isNew && !r.changed)).toBe(true);
        expect(b.recorded.map((r) => r.sourceItemId)).toEqual(a.recorded.map((r) => r.sourceItemId));
        for (const i of items) expect(await h.countSourceItems(i.dedupeKey)).toBe(1);
        const edited = { ...items[0]!, contentHash: 'h-edited' };
        const c = await page(scope, { from: '2026-10-30T10:00:00Z', to: '2026-10-30T11:00:00Z' }, [edited]);
        expect(c.recorded[0]).toMatchObject({ isNew: false, changed: true, sourceItemId: a.recorded[0]!.sourceItemId });
      });
    });

    describe('cursor + coverage (S7, S8, S9, S11, S12)', () => {
      it('finishRun advances the cursor with coverage; gaps reflect the ledger, clipped at the low watermark', async () => {
        const scope = newScope();
        expect(await s.coverageGaps(scope, { from: T('2026-10-30T07:00:00Z'), to: T('2026-10-30T08:00:00Z') })).toEqual([
          { from: T('2026-10-30T07:00:00Z'), to: T('2026-10-30T08:00:00Z') },
        ]);
        await page(scope, { from: '2026-10-30T08:00:00Z', to: '2026-10-30T10:00:00Z' }, []);
        expect(await s.getCursor(scope)).toEqual({ value: 'pos:2026-10-30T10:00:00Z', at: T('2026-10-30T10:00:00Z') });
        expect(await s.coverageGaps(scope, { from: T('2026-10-30T08:00:00Z'), to: T('2026-10-30T10:00:00Z') })).toEqual([]);
        expect(await s.coverageGaps(scope, { from: T('2026-10-30T07:00:00Z'), to: T('2026-10-30T11:00:00Z') })).toEqual([
          { from: T('2026-10-30T10:00:00Z'), to: T('2026-10-30T11:00:00Z') },
        ]);
      });

      it('a killed run leaves the cursor unmoved (its coverage is error) and a re-run produces the same final state', async () => {
        const scope = newScope();
        await page(scope, { from: '2026-10-30T08:00:00Z', to: '2026-10-30T09:00:00Z' }, []);
        const before = await s.getCursor(scope);
        const items = [item({ connector: 'slack', externalId: `k1-${sfx()}` }), item({ connector: 'slack', externalId: `k2-${sfx()}` })];
        const killed = await start(scope, '2026-10-30T09:00:00Z', '2026-10-30T10:00:00Z');
        const first = await s.recordSourceItems(killed, items);
        await s.reportCoverage(killed, [range(scope.scope, '2026-10-30T09:00:00Z', '2026-10-30T10:00:00Z')]);
        await s.failRun(killed, { error: 'aborted: worker killed', errorClass: 'transient' });
        expect(await s.getCursor(scope)).toEqual(before);
        expect(await s.coverageGaps(scope, { from: T('2026-10-30T09:00:00Z'), to: T('2026-10-30T10:00:00Z') })).toEqual([
          { from: T('2026-10-30T09:00:00Z'), to: T('2026-10-30T10:00:00Z') },
        ]);
        const again = await page(scope, { from: '2026-10-30T09:00:00Z', to: '2026-10-30T10:00:00Z' }, items);
        expect(again.recorded.map((r) => r.sourceItemId)).toEqual(first.map((r) => r.sourceItemId));
        expect(again.recorded.every((r) => !r.isNew)).toBe(true);
        expect((await s.getCursor(scope))?.at).toBe(T('2026-10-30T10:00:00Z'));
      });

      it('rejects a cursor outside the window and a window with a hole; never moves the cursor backwards', async () => {
        const scope = newScope();
        await page(scope, { from: '2026-10-30T08:00:00Z', to: '2026-10-30T10:00:00Z' }, []);
        const out = await start(scope, '2026-10-30T10:00:00Z', '2026-10-30T11:00:00Z');
        await s.reportCoverage(out, [range(scope.scope, '2026-10-30T10:00:00Z', '2026-10-30T11:00:00Z')]);
        await expect(s.finishRun(out, { cursor: { value: 'x', at: T('2026-10-30T09:00:00Z') }, stats: stats() })).rejects.toThrow(/window/i);
        await s.failRun(out, { error: 'cursor outside window' });
        const hole = await start(scope, '2026-10-30T10:00:00Z', '2026-10-30T12:00:00Z');
        await s.reportCoverage(hole, [range(scope.scope, '2026-10-30T11:00:00Z', '2026-10-30T12:00:00Z')]);
        await expect(s.finishRun(hole, { cursor: { value: 'y', at: T('2026-10-30T12:00:00Z') }, stats: stats() })).rejects.toThrow(/coverage/i);
        await s.failRun(hole, { error: 'coverage gap' });
        expect((await s.getCursor(scope))?.at).toBe(T('2026-10-30T10:00:00Z'));
        // An older window that is covered succeeds but cannot move the cursor back.
        await page(scope, { from: '2026-10-30T08:00:00Z', to: '2026-10-30T09:00:00Z' }, []);
        expect((await s.getCursor(scope))?.at).toBe(T('2026-10-30T10:00:00Z'));
      });

      it('the low watermark counts point coverage too (S11)', async () => {
        const scope = newScope();
        await page(scope, { from: '2026-10-30T08:00:00Z', to: '2026-10-30T09:00:00Z' }, [], {
          cover: [{ kind: 'message', ref: `C1:${sfx()}`, from: T('2026-10-30T07:00:00Z'), to: T('2026-10-30T07:00:00Z') }, range(scope.scope, '2026-10-30T08:00:00Z', '2026-10-30T09:00:00Z')],
        });
        expect(await s.coverageGaps(scope, { from: T('2026-10-30T06:00:00Z'), to: T('2026-10-30T09:00:00Z') })).toEqual([
          { from: T('2026-10-30T07:00:00Z'), to: T('2026-10-30T08:00:00Z') },
        ]);
        expect((await s.getCursor(scope))?.at).toBe(T('2026-10-30T09:00:00Z'));
      });

      it('bridges holes up to 1 s', async () => {
        const scope = newScope();
        const runId = await start(scope, '2026-10-30T08:00:00Z', '2026-10-30T10:00:00Z');
        await s.reportCoverage(runId, [range(scope.scope, '2026-10-30T08:00:00Z', '2026-10-30T09:00:00Z'), range(scope.scope, '2026-10-30T09:00:00.500Z', '2026-10-30T10:00:00Z')]);
        await s.finishRun(runId, { cursor: { value: 'z', at: T('2026-10-30T10:00:00Z') }, stats: stats() });
        expect((await s.getCursor(scope))?.at).toBe(T('2026-10-30T10:00:00Z'));
        expect(await s.coverageGaps(scope, { from: T('2026-10-30T08:00:00Z'), to: T('2026-10-30T10:00:00Z') })).toEqual([]);
      });

      it('weekend gap: head hour first, then backfill oldest to newest; the cursor fast-forwards and the ledger has no holes', async () => {
        const scope = newScope();
        const fri = Date.parse('2026-10-30T23:00:00Z');
        await page(scope, { from: new Date(fri - H).toISOString(), to: new Date(fri).toISOString() }, []);
        const mon = Date.parse('2026-11-02T15:00:00Z');
        // 1. head (newest hour): commits coverage but holds the cursor at Friday.
        const head = await page(scope, { from: new Date(mon - H).toISOString(), to: new Date(mon).toISOString() }, [item({ connector: 'slack', externalId: `mon-${sfx()}`, occurredAt: new Date(mon - 600_000).toISOString() })], { trigger: 'catch_up' });
        expect(head.recorded[0]!.isNew).toBe(true);
        expect((await s.getCursor(scope))?.at).toBe(new Date(fri).toISOString());
        // 2. backfill in 6 h chunks, oldest first; each chunk advances the cursor; the last one meets the head.
        const ats: string[] = [];
        for (let t = fri; t < mon - H; t += 6 * H) {
          const to = Math.min(t + 6 * H, mon - H);
          await page(scope, { from: new Date(t).toISOString(), to: new Date(to).toISOString() }, [], { trigger: 'catch_up' });
          ats.push((await s.getCursor(scope))!.at);
        }
        expect(ats).toEqual([...ats].sort());
        expect(ats.at(-2)! < new Date(mon - H).toISOString()).toBe(true);
        expect(await s.getCursor(scope)).toEqual({ value: `pos:${new Date(mon).toISOString()}`, at: new Date(mon).toISOString() });
        expect(await s.coverageGaps(scope, { from: new Date(fri - H).toISOString(), to: new Date(mon).toISOString() })).toEqual([]);
      });

      it('uncoveredObjects: same kind + ref with to >= listed to, or containment in a parent range', async () => {
        const scope = newScope('drive');
        const f1 = `1FileAAAA${sfx()}${sfx()}`;
        const f2 = `1FileBBBB${sfx()}${sfx()}`;
        await page(scope, { from: '2026-10-30T08:00:00Z', to: '2026-10-30T09:00:00Z' }, [], {
          cover: [
            { kind: 'query_window', ref: 'drive:feed', from: T('2026-10-30T08:00:00Z'), to: T('2026-10-30T09:00:00Z') },
            { kind: 'file', ref: f1, from: T('2026-10-30T08:30:00Z'), to: T('2026-10-30T08:30:00Z') },
          ],
        });
        const listed: CoverageObject[] = [
          { kind: 'file', ref: f1, from: T('2026-10-30T08:30:00Z'), to: T('2026-10-30T08:30:00Z') },
          { kind: 'file', ref: f2, from: T('2026-10-30T08:40:00Z'), to: T('2026-10-30T08:40:00Z') },
          { kind: 'file', ref: f1, from: T('2026-10-30T08:50:00Z'), to: T('2026-10-30T08:50:00Z') },
          { kind: 'file', ref: `1FileCCCC${sfx()}${sfx()}`, from: T('2026-10-30T08:45:00Z'), meta: { parentRef: 'drive:feed' } },
          { kind: 'file', ref: `1FileDDDD${sfx()}${sfx()}`, from: T('2026-10-30T09:30:00Z'), meta: { parentRef: 'drive:feed' } },
        ];
        const un = await s.uncoveredObjects(scope, listed);
        expect(un).toEqual([listed[1], listed[2], listed[4]]);
      });
    });

    describe('trainings first seen long after their due date (TRAIN-1)', () => {
      it('an old notice, due over two weeks ago, lands in Triage; a fresh overdue reminder lands open', async () => {
        const scope = newScope('trainings');
        const runId = await start(scope);
        const days = (n: number) => new Date(Date.now() - n * 24 * H).toISOString();
        const [old] = await s.recordSourceItems(runId, [item({ connector: 'trainings', externalId: `t-${sfx()}`, occurredAt: days(40), excerpt: 'Action Required: update your device' })]);
        const [fresh] = await s.recordSourceItems(runId, [item({ connector: 'trainings', externalId: `t-${sfx()}`, occurredAt: days(1), excerpt: 'Overdue: compliance training' })]);
        const stale = await s.proposeItem(runId, { kind: 'training', title: 'Update the device OS', due: days(33), evidence: [{ sourceItemId: old!.sourceItemId, role: 'origin', reason: 'notice: overdue' }], confidence: 'sure' });
        expect(stale.landedAs).toBe('suggested');
        expect((await h.workItem(stale.workItemId))?.status).toBe('suggested');
        const live = await s.proposeItem(runId, { kind: 'training', title: 'Finish the compliance training', due: days(20), evidence: [{ sourceItemId: fresh!.sourceItemId, role: 'origin', reason: 'notice: overdue' }], confidence: 'sure' });
        expect(live.landedAs).toBe('open');
        // MIN-9: no due date: an old notice goes to Triage, a recent one stays open.
        const [ancient] = await s.recordSourceItems(runId, [item({ connector: 'trainings', externalId: `t-${sfx()}`, occurredAt: days(90), excerpt: 'Your onboarding begins soon' })]);
        const noDateOld = await s.proposeItem(runId, { kind: 'training', title: 'Complete the onboarding curriculum', evidence: [{ sourceItemId: ancient!.sourceItemId, role: 'origin', reason: 'notice: assigned' }], confidence: 'likely' });
        expect(noDateOld.landedAs).toBe('suggested');
        const noDateNew = await s.proposeItem(runId, { kind: 'training', title: 'Attend the readiness session', evidence: [{ sourceItemId: fresh!.sourceItemId, role: 'origin', reason: 'notice: assigned' }], confidence: 'likely' });
        expect(noDateNew.landedAs).toBe('open');
      });

      it('DEEP-1: any ask over 30 days old when first seen lands in Triage, unless it is due later', async () => {
        const scope = newScope('slack');
        const runId = await start(scope);
        const days = (n: number) => new Date(Date.now() - n * 24 * H).toISOString();
        const [old] = await s.recordSourceItems(runId, [item({ connector: 'slack', externalId: `a-${sfx()}`, occurredAt: days(45), excerpt: 'Can you send the sizing notes?' })]);
        const [recent] = await s.recordSourceItems(runId, [item({ connector: 'slack', externalId: `a-${sfx()}`, occurredAt: days(20), excerpt: 'Can you review the deck?' })]);
        const stale = await s.proposeItem(runId, { kind: 'ask', title: 'Send the sizing notes', evidence: [{ sourceItemId: old!.sourceItemId, role: 'origin', reason: 'ask' }], confidence: 'sure' });
        expect(stale.landedAs).toBe('suggested');
        expect((await h.workItem(stale.workItemId))?.status).toBe('suggested');
        const fresh = await s.proposeItem(runId, { kind: 'ask', title: 'Review the deck', evidence: [{ sourceItemId: recent!.sourceItemId, role: 'origin', reason: 'ask' }], confidence: 'sure' });
        expect(fresh.landedAs).toBe('open');
        // an old message about a date still ahead is a live commitment
        const [plan] = await s.recordSourceItems(runId, [item({ connector: 'slack', externalId: `a-${sfx()}`, occurredAt: days(40), excerpt: 'Present at the QBR next week' })]);
        const ahead = await s.proposeItem(runId, { kind: 'commitment', title: 'Present at the QBR', due: new Date(Date.now() + 5 * 24 * H).toISOString(), evidence: [{ sourceItemId: plan!.sourceItemId, role: 'origin', reason: 'commitment' }], confidence: 'sure' });
        expect(ahead.landedAs).toBe('open');
      });
    });

    describe('linking: signals, never state (S3, S10)', () => {
      it('"I\'ll send the deck" in Slack then an email with the deck attached link to one item: origin then completion', async () => {
        const scope = newScope();
        const thread = `slack:C1:${sfx()}`;
        const deck = `1DeckId${sfx()}${sfx()}`;
        const runId = await start(scope);
        const [promise] = await s.recordSourceItems(runId, [item({ connector: 'slack', externalId: `p-${sfx()}`, threadRef: thread, excerpt: "I'll send the deck by EOD", author: { isMe: true, name: 'Me' } })]);
        const { workItemId, landedAs } = await s.proposeItem(runId, {
          kind: 'commitment',
          title: 'Send ACME the workshop deck',
          evidence: [{ sourceItemId: promise!.sourceItemId, role: 'origin', reason: "my commitment: \"I'll send the deck\"" }],
          confidence: 'sure',
        });
        expect(landedAs).toBe('open');
        await s.reportCoverage(runId, [range(scope.scope, '2026-10-30T09:00:00Z', '2026-10-30T10:00:00Z')]);
        const fin1 = await s.finishRun(runId, { cursor: { value: 'a', at: T('2026-10-30T10:00:00Z') }, stats: stats(1) });
        expect(fin1.touchedWorkItemIds).toEqual([workItemId]);

        const gscope = newScope('gmail');
        const run2 = await start(gscope, '2026-10-30T10:00:00Z', '2026-10-30T11:00:00Z');
        const [mail] = await s.recordSourceItems(run2, [item({ connector: 'gmail', externalId: `e-${sfx()}`, fileRefs: [deck], author: { isMe: true }, excerpt: 'Deck attached' })]);
        const byText = await s.findCandidates({ text: 'Here is the ACME workshop deck, attached', limit: 5 });
        expect(byText[0]?.workItemId).toBe(workItemId);
        await s.linkEvidence(run2, { workItemId, sourceItemId: mail!.sourceItemId, role: 'completion', confidence: 'sure', reason: 'sent the deck by email' });
        const byThread = await s.findCandidates({ threadRefs: [thread] });
        expect(byThread[0]).toMatchObject({ workItemId });
        const byFile = await s.findCandidates({ fileRefs: [deck] });
        expect(byFile[0]?.workItemId).toBe(workItemId);
        await s.reportCoverage(run2, [range('gmail:inbox', '2026-10-30T10:00:00Z', '2026-10-30T11:00:00Z', 'mailbox_range')]);
        const fin2 = await s.finishRun(run2, { cursor: { value: 'b', at: T('2026-10-30T11:00:00Z') }, stats: stats(1) });
        expect(fin2.touchedWorkItemIds).toEqual([workItemId]);
        expect((await h.evidence(workItemId)).map((e) => e.role)).toEqual(['origin', 'completion']);
        // The scanner emits signals; it never closes the item (BE-3 does).
        expect((await h.workItem(workItemId))?.status).toBe('open');
      });

      it('a Drive edit on the linked deck is found by file and becomes progress; "Done, see deck" is completion', async () => {
        const deck = `1DeckProg${sfx()}${sfx()}`;
        const sl = newScope();
        const r1 = await start(sl);
        const [ask] = await s.recordSourceItems(r1, [item({ connector: 'slack', externalId: `ask-${sfx()}`, fileRefs: [deck] })]);
        const { workItemId } = await s.proposeItem(r1, { kind: 'deliverable', title: 'Refresh the QBR deck', expected: { fileId: deck, changes: ['new metrics slide'] }, evidence: [{ sourceItemId: ask!.sourceItemId, role: 'origin', reason: 'asked' }], confidence: 'likely' });
        const dr = await start(newScope('drive'));
        const [edit] = await s.recordSourceItems(dr, [item({ connector: 'drive', externalId: `${deck}@2026-10-30T09:30:00Z`, fileRefs: [deck], author: { isMe: true } })]);
        const cands = await s.findCandidates({ fileRefs: [deck] });
        expect(cands[0]).toMatchObject({ workItemId });
        expect(cands[0]!.score).toBeGreaterThanOrEqual(0.5);
        await s.linkEvidence(dr, { workItemId, sourceItemId: edit!.sourceItemId, role: 'progress', confidence: 'likely', reason: 'I edited the deck' });
        const [done] = await s.recordSourceItems(r1, [item({ connector: 'slack', externalId: `done-${sfx()}`, excerpt: 'Done, see deck', fileRefs: [deck] })]);
        await s.linkEvidence(r1, { workItemId, sourceItemId: done!.sourceItemId, role: 'completion', confidence: 'sure', reason: 'said done in Slack' });
        expect((await h.evidence(workItemId)).map((e) => e.role).sort()).toEqual(['completion', 'origin', 'progress']);
        expect((await h.workItem(workItemId))?.status).toBe('open');
        await s.failRun(r1, { error: 'test end' });
        await s.failRun(dr, { error: 'test end' });
      });

      it('new requirements after done are a contradiction signal and the item stays done (BE-3 reopens)', async () => {
        const scope = newScope();
        const done = await h.seedWorkItem({ title: 'Build demo org for ACME', status: 'done', resolution: 'done_by_me' });
        const runId = await start(scope);
        const [req] = await s.recordSourceItems(runId, [item({ connector: 'slack', externalId: `req-${sfx()}`, excerpt: 'Can the demo org also show the agent handoff?' })]);
        await s.linkEvidence(runId, { workItemId: done, sourceItemId: req!.sourceItemId, role: 'contradiction', confidence: 'likely', reason: 'new requirement after done' });
        expect((await h.workItem(done))?.status).toBe('done');
        await s.reportCoverage(runId, [range(scope.scope, '2026-10-30T09:00:00Z', '2026-10-30T10:00:00Z')]);
        expect((await s.finishRun(runId, { cursor: { value: 'c', at: T('2026-10-30T10:00:00Z') }, stats: stats(1) })).touchedWorkItemIds).toEqual([done]);
      });

      it('evidence is unique per (item, source, role); a repeat creates nothing and touches nothing', async () => {
        const scope = newScope();
        const wi = await h.seedWorkItem({ title: 'Handed-off pricing question', status: 'done', resolution: 'handed_off', involvement: 'watcher' });
        const r1 = await start(scope);
        const [m] = await s.recordSourceItems(r1, [item({ connector: 'slack', externalId: `ctx-${sfx()}` })]);
        const a = await s.linkEvidence(r1, { workItemId: wi, sourceItemId: m!.sourceItemId, role: 'context', confidence: 'likely', reason: 'thread follow-up, handed off' });
        await s.reportCoverage(r1, [range(scope.scope, '2026-10-30T09:00:00Z', '2026-10-30T10:00:00Z')]);
        expect((await s.finishRun(r1, { cursor: { value: 'd', at: T('2026-10-30T10:00:00Z') }, stats: stats(1) })).touchedWorkItemIds).toEqual([wi]);
        const r2 = await start(scope, '2026-10-30T10:00:00Z', '2026-10-30T11:00:00Z');
        const b = await s.linkEvidence(r2, { workItemId: wi, sourceItemId: m!.sourceItemId, role: 'context', confidence: 'likely', reason: 'again' });
        expect(b.evidenceId).toBe(a.evidenceId);
        expect((await h.evidence(wi)).length).toBe(1);
        await s.reportCoverage(r2, [range(scope.scope, '2026-10-30T10:00:00Z', '2026-10-30T11:00:00Z')]);
        expect((await s.finishRun(r2, { cursor: { value: 'e', at: T('2026-10-30T11:00:00Z') }, stats: stats(1) })).touchedWorkItemIds).toEqual([]);
      });

      it('touches from a failed run are returned by the next successful finishRun of the scope', async () => {
        const scope = newScope();
        const wi = await h.seedWorkItem({ title: `Survives a crash ${sfx()}` });
        const r1 = await start(scope);
        const [m] = await s.recordSourceItems(r1, [item({ connector: 'slack', externalId: `surv-${sfx()}` })]);
        await s.linkEvidence(r1, { workItemId: wi, sourceItemId: m!.sourceItemId, role: 'progress', confidence: 'likely', reason: 'progress' });
        await s.failRun(r1, { error: 'killed', errorClass: 'transient' });
        const again = await page(scope, { from: '2026-10-30T09:00:00Z', to: '2026-10-30T10:00:00Z' }, [item({ connector: 'slack', externalId: `surv2-${sfx()}` })]);
        expect(again.touchedWorkItemIds).toEqual([wi]);
      });
    });

    describe('proposals (S4, S5)', () => {
      it('sure and likely land open, guess lands in Triage; a repeat is idempotent and only adds missing evidence', async () => {
        const scope = newScope();
        const runId = await start(scope);
        const [a, b, c, extra] = await s.recordSourceItems(runId, ['a', 'b', 'c', 'x'].map((x) => item({ connector: 'slack', externalId: `${x}-${sfx()}` })));
        const sure = await s.proposeItem(runId, { kind: 'ask', title: 'Share the SOW draft', evidence: [{ sourceItemId: a!.sourceItemId, role: 'origin', reason: 'asked me' }], confidence: 'sure' });
        const likely = await s.proposeItem(runId, { kind: 'commitment', title: 'Package the footprint app for SE_2', evidence: [{ sourceItemId: b!.sourceItemId, role: 'origin', reason: 'I promised' }], confidence: 'likely' });
        const guess = await s.proposeItem(runId, { kind: 'task', title: 'Maybe review the RFP', evidence: [{ sourceItemId: c!.sourceItemId, role: 'origin', reason: 'unclear' }], confidence: 'guess' });
        expect([sure.landedAs, likely.landedAs, guess.landedAs]).toEqual(['open', 'open', 'suggested']);
        expect((await h.workItem(guess.workItemId))?.status).toBe('suggested');
        const again = await s.proposeItem(runId, {
          kind: 'ask',
          title: 'Share the SOW draft (reworded by the model)',
          evidence: [
            { sourceItemId: a!.sourceItemId, role: 'origin', reason: 'asked me (re-run)' },
            { sourceItemId: extra!.sourceItemId, role: 'progress', reason: 'follow-up' },
          ],
          confidence: 'sure',
        });
        expect(again).toEqual(sure);
        expect((await h.evidence(sure.workItemId)).map((e) => e.role)).toEqual(['origin', 'progress']);
        const otherKind = await s.proposeItem(runId, { kind: 'task', title: 'Share the SOW draft', evidence: [{ sourceItemId: a!.sourceItemId, role: 'origin', reason: 'task view' }], confidence: 'sure' });
        expect(otherKind.workItemId).not.toBe(sure.workItemId);
        await expect(
          s.proposeItem(runId, { kind: 'ask', title: 'Bad initiative', initiativeId: 'ini_missing', evidence: [{ sourceItemId: b!.sourceItemId, role: 'context', reason: 'x' }], confidence: 'sure' }),
        ).rejects.toThrow(/initiative/i);
        await s.reportCoverage(runId, [range(scope.scope, '2026-10-30T09:00:00Z', '2026-10-30T10:00:00Z')]);
        const fin = await s.finishRun(runId, { cursor: { value: 'p', at: T('2026-10-30T10:00:00Z') }, stats: stats(4) });
        expect(fin.touchedWorkItemIds).toEqual([sure.workItemId, likely.workItemId, guess.workItemId, otherKind.workItemId].sort());
      });

      it('proposeInitiative is idempotent on (title, members) and sets the initiative on members without one', async () => {
        const scope = newScope();
        const w1 = await h.seedWorkItem({ title: 'Demo script' });
        const w2 = await h.seedWorkItem({ title: 'Demo org data' });
        const runId = await start(scope);
        const title = `Beta Corp agent demo ${sfx()}`;
        const a = await s.proposeInitiative(runId, { title, purpose: 'Agent demo on 11/12', workItemIds: [w1, w2] });
        const b = await s.proposeInitiative(runId, { title: ` ${title.toUpperCase()} `, purpose: 'Agent demo on 11/12', workItemIds: [w2, w1] });
        expect(b.initiativeId).toBe(a.initiativeId);
        const ctx = await s.getContext(scope, { maxOpenItems: 1000 });
        expect(ctx.openItems.find((o) => o.workItemId === w1)?.initiativeId).toBe(a.initiativeId);
        await s.failRun(runId, { error: 'test end' });
      });
    });

    describe('candidates (S15, S17)', () => {
      it('threadRefs ["cc:<id>"] matches that item exactly', async () => {
        const target = await h.seedWorkItem({ title: `Launched session task ${sfx()}` });
        await h.seedWorkItem({ title: 'Some other launched session task' });
        const c = await s.findCandidates({ threadRefs: [`cc:${target}`] });
        expect(c).toHaveLength(1);
        expect(c[0]).toMatchObject({ workItemId: target, score: 1 });
      });

      it('ranks by thread, people and account signals, explains why and carries resolution fields', async () => {
        const scope = newScope();
        const acct = await h.seedAccount({ name: `Gamma Health ${sfx()}`, aliases: [`gamma-${sfx()}`] });
        const wi = await h.seedWorkItem({ title: 'Answer the data residency question', accountId: acct, counterparty: { name: `Cust ${sfx()}`, email: `cust.${sfx()}@customer.example` } });
        const thread = `slack:C9:${sfx()}`;
        const runId = await start(scope);
        const [m] = await s.recordSourceItems(runId, [item({ connector: 'slack', externalId: `t-${sfx()}`, threadRef: thread })]);
        await s.linkEvidence(runId, { workItemId: wi, sourceItemId: m!.sourceItemId, role: 'origin', confidence: 'sure', reason: 'asked' });
        const byThread = await s.findCandidates({ threadRefs: [thread] });
        expect(byThread[0]).toMatchObject({ workItemId: wi, state: 'open' });
        expect(byThread[0]!.why).toMatch(/thread/);
        const byAccount = await s.findCandidates({ accounts: [acct], text: 'data residency' });
        expect(byAccount[0]?.workItemId).toBe(wi);
        expect(byAccount[0]!.why).toMatch(/account/);
        const handed = await h.seedWorkItem({ title: `Handed over residency follow-up ${sfx()}`, status: 'done', resolution: 'handed_off', involvement: 'not_involved' });
        const c = (await s.findCandidates({ text: 'handed over residency follow-up', limit: 10 })).find((x) => x.workItemId === handed);
        expect(c).toMatchObject({ resolution: 'handed_off', involvement: 'not_involved', state: 'done' });
        await s.failRun(runId, { error: 'test end' });
      });
    });

    describe('unlinked items (S6)', () => {
      it('counts attempts: other runs at most one, each reconcile run one, deferred never; evidence ends it', async () => {
        const scope = newScope();
        const find = async (id: string, o: { minAttempts?: number; maxAttempts?: number } = {}) =>
          ((await s.unlinkedSourceItems({ connector: 'slack', limit: 1000, ...o })) as UnlinkedSourceItemDetail[]).find((r) => r.sourceItemId === id);
        const r0 = await start(scope);
        const [x] = await s.recordSourceItems(r0, [item({ connector: 'slack', externalId: `u-${sfx()}`, title: 'Unclear ask' })]);
        await s.flagUnlinked(r0, { sourceItemId: x!.sourceItemId, reason: 'deferred: daily LLM hard cap' });
        expect((await find(x!.sourceItemId))?.attempts).toBe(0);
        const ra = await start(scope);
        await s.flagUnlinked(ra, { sourceItemId: x!.sourceItemId, reason: 'relevant, no confident home', hints: ['acme?'] });
        await s.flagUnlinked(ra, { sourceItemId: x!.sourceItemId, reason: 'same run twice counts once' });
        expect(await find(x!.sourceItemId)).toMatchObject({ attempts: 1, reason: 'same run twice counts once', connector: 'slack', title: 'Unclear ask' });
        expect((await find(x!.sourceItemId))?.hints).toContain('acme?');
        const r1 = await start(scope);
        await s.flagUnlinked(r1, { sourceItemId: x!.sourceItemId, reason: 'rescan still unsure' });
        expect((await find(x!.sourceItemId))?.attempts).toBe(1); // a rescan never escalates
        const rc = await start(scope, '2026-10-30T09:00:00Z', '2026-10-30T10:00:00Z', 'reconcile');
        await s.flagUnlinked(rc, { sourceItemId: x!.sourceItemId, reason: 'second try failed' });
        expect((await find(x!.sourceItemId, { minAttempts: 2, maxAttempts: 2 }))?.attempts).toBe(2);
        expect(await find(x!.sourceItemId, { minAttempts: 3 })).toBeUndefined();
        const wi = await h.seedWorkItem({ title: 'Home found later' });
        await s.linkEvidence(rc, { workItemId: wi, sourceItemId: x!.sourceItemId, role: 'origin', confidence: 'likely', reason: 'reconciled' });
        expect(await find(x!.sourceItemId)).toBeUndefined();
        for (const r of [r0, ra, r1, rc]) await s.failRun(r, { error: 'test end' });
      });
    });

    describe('health, spend, briefs (S13, S18)', () => {
      it('recordHealth accepts every probe state', async () => {
        for (const state of ['ok', 'degraded', 'auth_required', 'down', 'ok'] as const) {
          await s.recordHealth('vdp', { state, detail: `probe ${state}`, errorClass: state === 'ok' ? undefined : 'auth', checkedAt: new Date().toISOString() });
        }
      });

      it('recordSpend accumulates today, reports the caps, and costUsd 0 is a pure read', async () => {
        const a = await s.recordSpend({ connector: 'slack', model: 'claude-haiku-5-5', costUsd: 0.25, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
        const b = await s.recordSpend({ connector: 'nba', model: 'claude-sonnet-5', costUsd: 0.5, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
        expect(b.todayUsd).toBeCloseTo(a.todayUsd + 0.5, 6);
        const c = await s.recordSpend({ connector: 'slack', model: 'none', costUsd: 0 });
        expect(c.todayUsd).toBeCloseTo(b.todayUsd, 6);
        expect(b.hardCapUsd).toBeGreaterThan(0);
        expect(b.softCapUsd).toBeGreaterThan(0);
        expect(b.hardCapUsd).toBeGreaterThanOrEqual(b.softCapUsd);
      });

      it('recordBriefHighlights is idempotent per subscription period and requires cited items to exist', async () => {
        const scope: ScopeKey = { connector: 'watch', scope: `slack:channel:C${sfx()}` };
        const runId = await start(scope, '2026-10-30T00:00:00Z', '2026-10-31T00:00:00Z');
        const [m] = await s.recordSourceItems(runId, [item({ connector: 'slack', externalId: `b-${sfx()}` })]);
        const input = {
          subscription: { kind: 'channel' as const, ref: `C${sfx()}` },
          period: { from: T('2026-10-30T00:00:00Z'), to: T('2026-10-31T00:00:00Z') },
          summary: 'Two threads about the headless roadmap.',
          highlights: [{ title: 'Roadmap question for your account', relevance: 'high' as const, reasons: ['mentions my account'], sourceItemIds: [m!.sourceItemId], suggestedAction: 'task' as const }],
        };
        const a = await s.recordBriefHighlights(runId, input);
        const b = await s.recordBriefHighlights(runId, { ...input, summary: 'Regenerated.' });
        expect(b.briefId).toBe(a.briefId);
        await expect(s.recordBriefHighlights(runId, { ...input, highlights: [{ ...input.highlights[0]!, sourceItemIds: ['si_missing'] }] })).rejects.toThrow(/source item/i);
        await s.failRun(runId, { error: 'test end' });
      });
    });
  });
}
