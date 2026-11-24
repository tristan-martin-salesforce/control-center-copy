import { describe, expect, it } from 'vitest';
import { CoverageError, InMemoryScannerStore, RunStateError } from '../../../src/scanner/store-memory';
import { FakeClock } from '../../../src/scanner/runtime/clock';
import type { NormalizedSourceItem } from '../../../src/scanner/types';
import { PROFILE } from './helpers/world';

const scope = { connector: 'slack' as const, scope: 'inbox' };
const item = (ext: string, text: string, extra: Partial<NormalizedSourceItem> = {}): NormalizedSourceItem => ({
  connector: 'slack',
  kind: 'message',
  externalId: ext,
  dedupeKey: `slack:${ext}`,
  contentHash: `h:${text}`,
  occurredAt: '2026-11-04T16:00:00.000Z',
  excerpt: text,
  ...extra,
});

function setup() {
  const clock = new FakeClock('2026-11-05T15:00:00Z');
  const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
  return { clock, store };
}

const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse('2026-11-05T00:00:00Z');

async function scan(store: InMemoryScannerStore, from: number, to: number, cursorAt = to, cover: Array<[number, number]> = [[from, to]]) {
  const { runId } = await store.startRun({ scope, trigger: 'schedule', window: { from: iso(from), to: iso(to) } });
  await store.reportCoverage(runId, cover.map(([a, b]) => ({ kind: 'query_window', ref: 'search:dm', from: iso(a), to: iso(b) })));
  return { runId, finish: () => store.finishRun(runId, { cursor: { value: String(cursorAt / 1000), at: iso(cursorAt) }, stats: { fetched: 0, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, costUsd: 0 } }) };
}

describe('InMemoryScannerStore semantics (BE-1 mirrors these)', () => {
  it('S2: source items are idempotent by dedupeKey; a changed hash is an edit', async () => {
    const { store } = setup();
    const { runId } = await store.startRun({ scope, trigger: 'schedule', window: { from: iso(T0), to: iso(T0 + H) } });
    const a = await store.recordSourceItems(runId, [item('D1:1.1', 'hello')]);
    const b = await store.recordSourceItems(runId, [item('D1:1.1', 'hello')]);
    const c = await store.recordSourceItems(runId, [item('D1:1.1', 'hello (edited)')]);
    expect(a[0]).toMatchObject({ isNew: true, changed: false });
    expect(b[0]).toMatchObject({ sourceItemId: a[0]!.sourceItemId, isNew: false, changed: false });
    expect(c[0]).toMatchObject({ sourceItemId: a[0]!.sourceItemId, isNew: false, changed: true });
    expect(store.getSourceItem(a[0]!.sourceItemId)!.revision).toBe(2);
    await expect(store.recordSourceItems(runId, [{ ...item('X', 'y'), connector: 'gmail' }])).rejects.toThrow(/connector/);
  });

  it('S1: writes to a finished run are rejected', async () => {
    const { store } = setup();
    const r = await scan(store, T0, T0 + H);
    await r.finish();
    await expect(store.recordSourceItems(r.runId, [item('D1:2', 'x')])).rejects.toBeInstanceOf(RunStateError);
  });

  it('S3/S4: evidence and proposals are idempotent', async () => {
    const { store } = setup();
    const { runId } = await store.startRun({ scope, trigger: 'schedule', window: { from: iso(T0), to: iso(T0 + H) } });
    const [s] = await store.recordSourceItems(runId, [item('D1:3', "I'll send the deck", { threadRef: 'slack:D1:3' })]);
    const p1 = await store.proposeItem(runId, { kind: 'commitment', title: 'Send deck to PERSON_D', evidence: [{ sourceItemId: s!.sourceItemId, role: 'origin', reason: 'r' }], confidence: 'likely' });
    const p2 = await store.proposeItem(runId, { kind: 'commitment', title: 'Send the deck (reworded)', evidence: [{ sourceItemId: s!.sourceItemId, role: 'origin', reason: 'r' }], confidence: 'likely' });
    expect(p2.workItemId).toBe(p1.workItemId);
    expect(p1.landedAs).toBe('open');
    expect(store.listWorkItems().find((w) => w.workItemId === p1.workItemId)!.newBadge).toBe(true);
    const e1 = await store.linkEvidence(runId, { workItemId: p1.workItemId, sourceItemId: s!.sourceItemId, role: 'origin', confidence: 'sure', reason: 'again' });
    expect(store.evidenceFor(p1.workItemId)).toHaveLength(1);
    expect(e1.touchedWorkItemId).toBe(p1.workItemId);
    const g = await store.proposeItem(runId, { kind: 'ask', title: 'Maybe something', evidence: [{ sourceItemId: s!.sourceItemId, role: 'origin', reason: 'r' }], confidence: 'guess' });
    expect(g.landedAs).toBe('suggested');
  });

  it('S8: finishRun rejects a cursor beyond the coverage, and leaves the run open for failRun', async () => {
    const { store } = setup();
    const r = await scan(store, T0, T0 + 2 * H, T0 + 2 * H, [[T0, T0 + H]]);
    await expect(r.finish()).rejects.toBeInstanceOf(CoverageError);
    expect(store.getRun(r.runId)!.status).toBe('running');
    expect(await store.getCursor(scope)).toBeNull();
    await store.failRun(r.runId, { error: 'coverage', errorClass: 'config' });
    expect(store.ledger(scope).every((l) => l.outcome === 'error')).toBe(true);
  });

  it('S9: head run does not move the cursor over a hole; backfill closes it and fast-forwards', async () => {
    const { store } = setup();
    await (await scan(store, T0, T0 + H)).finish(); // cursor = T0+1h
    expect((await store.getCursor(scope))!.at).toBe(iso(T0 + H));
    await (await scan(store, T0 + 9 * H, T0 + 10 * H)).finish(); // head: hole 1h..9h
    expect((await store.getCursor(scope))!.at).toBe(iso(T0 + H));
    expect(await store.coverageGaps(scope, { from: iso(T0), to: iso(T0 + 10 * H) })).toEqual([{ from: iso(T0 + H), to: iso(T0 + 9 * H) }]);
    await (await scan(store, T0 + H, T0 + 7 * H)).finish();
    expect((await store.getCursor(scope))!.at).toBe(iso(T0 + 7 * H));
    await (await scan(store, T0 + 7 * H, T0 + 9 * H)).finish();
    expect((await store.getCursor(scope))!.at).toBe(iso(T0 + 10 * H)); // fast-forward to the head run's cursor
    expect(await store.coverageGaps(scope, { from: iso(T0), to: iso(T0 + 10 * H) })).toEqual([]);
  });

  it('S7: a failed run’s coverage never counts', async () => {
    const { store } = setup();
    await (await scan(store, T0, T0 + H)).finish();
    const r = await scan(store, T0 + H, T0 + 2 * H);
    await store.failRun(r.runId, { error: 'killed' });
    expect((await store.getCursor(scope))!.at).toBe(iso(T0 + H));
    expect(await store.coverageGaps(scope, { from: iso(T0), to: iso(T0 + 2 * H) })).toEqual([{ from: iso(T0 + H), to: iso(T0 + 2 * H) }]);
  });

  it('S10: touches from a killed run are fanned out by the next successful finish', async () => {
    const { store } = setup();
    const r1 = await scan(store, T0, T0 + H);
    const [s] = await store.recordSourceItems(r1.runId, [item('D1:9', 'ask')]);
    const p = await store.proposeItem(r1.runId, { kind: 'ask', title: 'Do the thing', evidence: [{ sourceItemId: s!.sourceItemId, role: 'origin', reason: 'r' }], confidence: 'sure' });
    await store.failRun(r1.runId, { error: 'killed' });
    const r2 = await scan(store, T0, T0 + H);
    await store.proposeItem(r2.runId, { kind: 'ask', title: 'Do the thing', evidence: [{ sourceItemId: s!.sourceItemId, role: 'origin', reason: 'r' }], confidence: 'sure' }); // no new row
    expect((await r2.finish()).touchedWorkItemIds).toEqual([p.workItemId]);
    const r3 = await scan(store, T0 + H, T0 + 2 * H);
    expect((await r3.finish()).touchedWorkItemIds).toEqual([]);
  });

  it('caps audit: the reconciler re-reads every unlinked row (limit Infinity), not the first 50 or 500', async () => {
    const { store } = setup();
    const r = await scan(store, T0, T0 + H);
    const rows = await store.recordSourceItems(r.runId, Array.from({ length: 520 }, (_, i) => item(`D9:${i}.1`, `fyi ${i}`)));
    for (const x of rows) await store.flagUnlinked(r.runId, { sourceItemId: x.sourceItemId, reason: 'PERSON_G: which item?' });
    await r.finish();
    expect(await store.unlinkedSourceItems({ connector: 'slack' })).toHaveLength(50); // the default page
    expect(await store.unlinkedSourceItems({ connector: 'slack', limit: Number.POSITIVE_INFINITY })).toHaveLength(520);
  });

  it('S6: unlinked attempts escalate only on reconcile runs; deferred never counts', async () => {
    const { store } = setup();
    const r = await scan(store, T0, T0 + H);
    const [s, d] = await store.recordSourceItems(r.runId, [item('D1:20', 'fyi GLOBEX'), item('D1:21', 'deferred one')]);
    await store.flagUnlinked(r.runId, { sourceItemId: s!.sourceItemId, reason: 'PERSON_G: GLOBEX meeting moved' });
    await store.flagUnlinked(r.runId, { sourceItemId: s!.sourceItemId, reason: 'PERSON_G: GLOBEX meeting moved' });
    await store.flagUnlinked(r.runId, { sourceItemId: d!.sourceItemId, reason: 'deferred: budget' });
    await r.finish();
    expect(store.unlinkedRow(s!.sourceItemId)!.attempts).toBe(1);
    expect(store.unlinkedRow(d!.sourceItemId)!.attempts).toBe(0);
    const again = await scan(store, T0, T0 + H);
    await store.flagUnlinked(again.runId, { sourceItemId: s!.sourceItemId, reason: 'rescan' });
    expect(store.unlinkedRow(s!.sourceItemId)!.attempts).toBe(1); // rescans never escalate
    const rec = await store.startRun({ scope: { connector: 'slack', scope: 'reconcile:unlinked' }, trigger: 'reconcile', window: { from: iso(T0), to: iso(T0) } });
    await store.flagUnlinked(rec.runId, { sourceItemId: s!.sourceItemId, reason: 'x' });
    await store.flagUnlinked(rec.runId, { sourceItemId: s!.sourceItemId, reason: 'x' });
    expect(store.unlinkedRow(s!.sourceItemId)!.attempts).toBe(2); // once per reconcile run
    const list = await store.unlinkedSourceItems({ connector: 'slack' });
    expect(list.map((u) => u.sourceItemId).sort()).toEqual([s!.sourceItemId, d!.sourceItemId].sort());
    expect(list.find((u) => u.sourceItemId === s!.sourceItemId)).toMatchObject({ excerpt: 'fyi GLOBEX' });
  });

  it('S11/S12: gaps are clipped at the low watermark; uncovered objects by ref/version or parent range', async () => {
    const { store } = setup();
    expect(await store.coverageGaps(scope, { from: iso(T0), to: iso(T0 + H) })).toEqual([{ from: iso(T0), to: iso(T0 + H) }]);
    const r = await scan(store, T0 + 2 * H, T0 + 3 * H);
    await store.reportCoverage(r.runId, [{ kind: 'file', ref: 'drive:F1', to: '2026-11-05T02:30:00Z' }]);
    await r.finish();
    expect(await store.coverageGaps(scope, { from: iso(T0), to: iso(T0 + 3 * H) })).toEqual([]); // before the watermark: not a gap
    const missing = await store.uncoveredObjects(scope, [
      { kind: 'file', ref: 'drive:F1', to: '2026-11-05T02:00:00Z' },
      { kind: 'file', ref: 'drive:F1', to: '2026-11-05T02:45:00Z' },
      { kind: 'message', ref: 'D1:77', from: iso(T0 + 2.5 * H), meta: { parentRef: 'search:dm' } },
      { kind: 'message', ref: 'D1:78', from: iso(T0 + 5 * H), meta: { parentRef: 'search:dm' } },
    ]);
    expect(missing.map((m) => `${m.ref}@${m.to ?? m.from}`)).toEqual(['drive:F1@2026-11-05T02:45:00Z', `D1:78@${iso(T0 + 5 * H)}`]);
  });

  it('S13: recordSpend(0) is a pure read; totals are per day', async () => {
    const { store, clock } = setup();
    expect((await store.recordSpend({ connector: 'slack', model: 'none', costUsd: 0 })).todayUsd).toBe(0);
    await store.recordSpend({ connector: 'slack', model: 'claude-haiku-5-5', costUsd: 0.25, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
    expect((await store.recordSpend({ connector: 'slack', model: 'none', costUsd: 0 })).todayUsd).toBeCloseTo(0.25);
    clock.advance(24 * H);
    expect((await store.recordSpend({ connector: 'slack', model: 'none', costUsd: 0 })).todayUsd).toBe(0);
  });

  it('S15/S17: candidates carry resolution/involvement; cc:<workItemId> threads join exactly', async () => {
    const { store } = setup();
    const w = store.seedWorkItem({ kind: 'deliverable', title: 'GLOBEX sizing workbook', resolution: 'handed_off', involvement: 'watcher', threadRefs: ['slack:C0GLOBEX1:1.1'] });
    const c = (await store.findCandidates({ threadRefs: ['slack:C0GLOBEX1:1.1'] }))[0] as any;
    expect(c).toMatchObject({ workItemId: w, resolution: 'handed_off', involvement: 'watcher' });
    expect(await store.findCandidates({ threadRefs: ['slack:C0GLOBEX1:1.10'] })).toEqual([]);
    const other = store.seedWorkItem({ kind: 'task', title: 'Build the demo org' });
    expect((await store.findCandidates({ threadRefs: [`cc:${other}`] }))[0]).toMatchObject({ workItemId: other, score: 1 });
    const ctx = await store.getContext(scope);
    expect(ctx.openItems.find((o) => o.workItemId === w)).toMatchObject({ resolution: 'handed_off', involvement: 'watcher' });
  });

  it('S18: brief highlights are idempotent per subscription + period', async () => {
    const { store } = setup();
    const r = await scan(store, T0, T0 + H);
    const [s] = await store.recordSourceItems(r.runId, [item('C9:1.1', 'Private Connect GA')]);
    const input = { subscription: { kind: 'channel' as const, ref: 'C9' }, period: { from: iso(T0), to: iso(T0 + H) }, summary: 's', highlights: [{ title: 'GA', relevance: 'high' as const, reasons: ['matches ACME'], sourceItemIds: [s!.sourceItemId], suggestedAction: 'promote' as const }] };
    const a = await store.recordBriefHighlights(r.runId, input);
    const b = await store.recordBriefHighlights(r.runId, { ...input, summary: 's2' });
    expect(b.briefId).toBe(a.briefId);
    expect(store.listBriefs()).toHaveLength(1);
    await expect(store.recordBriefHighlights(r.runId, { ...input, highlights: [{ ...input.highlights[0]!, sourceItemIds: ['nope'] }] })).rejects.toThrow();
  });
});
