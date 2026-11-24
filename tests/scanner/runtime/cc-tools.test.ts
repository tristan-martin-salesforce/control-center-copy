import { describe, expect, it } from 'vitest';
import { callCcTool, contentHashOf, createCcHandlers, createRunState, parseHighlightsBlock } from '../../../src/llm/cc-tools';
import { redact } from '../../../src/llm/redact';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import { FakeClock } from '../../../src/scanner/runtime/clock';
import { PROFILE } from './helpers/world';

async function setup(window = { from: '2026-11-04T16:00:00.000Z', to: '2026-11-04T18:00:00.000Z' }, connector: 'slack' | 'watch' = 'slack', scope = 'inbox') {
  const store = new InMemoryScannerStore({ clock: new FakeClock('2026-11-04T18:00:00Z'), profile: structuredClone(PROFILE) });
  const { runId } = await store.startRun({ scope: { connector, scope }, trigger: 'schedule', window });
  const ctx = await store.getContext({ connector, scope });
  const state = createRunState({ runId, connector, window, context: ctx });
  const h = createCcHandlers(store, state);
  const call = async (name: string, args: unknown) => {
    const r = await callCcTool(h, state, name, args);
    return { ...r, json: JSON.parse(r.text) };
  };
  return { store, state, call, runId };
}

describe('cc tools', () => {
  it('validates inputs with zod and returns a compact error', async () => {
    const { call } = await setup();
    const r = await call('cc_link_evidence', { workItemId: 'w', sourceItemId: 's', role: 'closed', confidence: 'sure', reason: 'x' });
    expect(r.isError).toBe(true);
    expect(r.json.error).toMatch(/invalid input: role/);
    expect((await call('cc_nope', {})).isError).toBe(true);
  });

  it('derives dedupeKey and contentHash itself and redacts excerpts again (defense in depth)', async () => {
    const { call, store } = await setup();
    const item = { kind: 'message', externalId: 'D0DM00003:1793822400.000100', dedupeKey: 'anything', contentHash: 'model-made', occurredAt: '1793822400.000100', excerpt: 'demo login is demo@example.com / password: Hunter2-placeholder and token xoxb-1234567890-abcdefghij' };
    const a = await call('cc_record_source_items', { items: [item] });
    const b = await call('cc_record_source_items', { items: [{ ...item, excerpt: `${item.excerpt}  ` }] }); // whitespace-only change
    expect(a.json.items[0]).toMatchObject({ new: true, red: true });
    expect(b.json.items[0]).toMatchObject({ id: a.json.items[0].id, new: false, chg: false });
    const row = store.getSourceItem(a.json.items[0].id)!;
    expect(row.dedupeKey).toBe('slack:D0DM00003:1793822400.000100');
    expect(row.occurredAt).toBe('2026-11-04T20:00:00.000Z');
    expect(row.excerpt).not.toMatch(/Hunter2|xoxb-1234/);
    expect(row.redacted).toBe(true);
  });

  it('watch runs record Slack messages under the Slack key (one row per message)', async () => {
    const { call, store } = await setup(undefined, 'watch', 'slack:channel:C0WATCH01');
    const r = await call('cc_record_source_items', { items: [{ kind: 'message', externalId: 'C0WATCH01:1793822400.000100', occurredAt: '1793822400.000100', excerpt: 'GA this week' }] });
    expect(store.getSourceItem(r.json.items[0].id)!.dedupeKey).toBe('slack:C0WATCH01:1793822400.000100');
  });

  it('clamps coverage to the window and rejects cc_finish over a hole', async () => {
    const { call, state } = await setup();
    await call('cc_report_coverage', { windows: [{ ref: 'search:dm', from: '2026-11-04T10:00:00Z', to: '2026-11-05T10:00:00Z' }] });
    expect(state.coverage[0]).toMatchObject({ kind: 'query_window', from: '2026-11-04T15:50:00.000Z', to: '2026-11-04T18:00:00.000Z' });

    const s2 = await setup();
    await s2.call('cc_report_coverage', { windows: [{ ref: 'search:dm', from: '1793808000', to: '1793811600' }] }); // 16:00 → 17:00 as Slack ts
    const bad = await s2.call('cc_finish', { cursor: { value: '1793815200.000000', at: '2026-11-04T18:00:00Z' } });
    expect(bad.isError).toBe(true);
    expect(bad.json.error).toMatch(/hole 2026-11-04T17:00:00.000Z/);
    const ok = await s2.call('cc_finish', { cursor: { value: '1793811600.000000', at: '2026-11-04T17:00:00Z' }, complete: false });
    expect(ok.json).toMatchObject({ ok: true, complete: false });
    expect(s2.state.coverage[0]!.meta).toMatchObject({ startToken: '1793808000', endToken: '1793811600' });
    expect((await s2.call('cc_flag_unlinked', { sourceItemId: 'x', reason: 'after finish' })).json.error).toMatch(/already finished/);
  });

  it('R-UI-22: coerces non-context roles on handed-off items, but allows a loop_back origin', async () => {
    const { call, store, state } = await setup();
    const w = store.seedWorkItem({ kind: 'deliverable', title: 'GLOBEX sizing workbook', threadRefs: ['slack:C0GLOBEX1:1793900000.000100'], resolution: 'handed_off', involvement: 'watcher' });
    const rec = await call('cc_record_source_items', { items: [{ kind: 'message', externalId: 'C0GLOBEX1:1793900100.000100', occurredAt: '1793900100.000100', excerpt: 'FYI review moved', threadRef: 'slack:C0GLOBEX1:1793900000.000100' }, { kind: 'message', externalId: 'D0DM00005:1793900200.000100', occurredAt: '1793900200.000100', excerpt: 'Can you join Friday?' }] });
    const cands = await call('cc_find_candidates', { threadRefs: ['slack:C0GLOBEX1:1793900000.000100'] });
    expect(cands.json.candidates[0]).toMatchObject({ w, res: 'handed_off', inv: 'watcher' });
    const fyi = await call('cc_link_evidence', { workItemId: w, sourceItemId: rec.json.items[0].id, role: 'progress', confidence: 'sure', reason: 'status' });
    expect(fyi.json).toMatchObject({ role: 'context' });
    expect(fyi.json.coerced).toMatch(/progress→context/);
    const ask = await call('cc_link_evidence', { workItemId: w, sourceItemId: rec.json.items[1].id, role: 'origin', confidence: 'sure', reason: 'loop_back: PERSON_E asked me directly to join Friday' });
    expect(ask.json).toMatchObject({ role: 'origin' });
    expect(store.evidenceFor(w).map((e) => e.role).sort()).toEqual(['context', 'origin']);
    expect(state.counts.linked).toBe(2);
  });

  it('records brief highlights via the tool, and parses the HIGHLIGHTS v1 fallback', async () => {
    const { call, store, state } = await setup({ from: '2026-11-04T00:00:00.000Z', to: '2026-11-05T00:00:00.000Z' }, 'watch', 'slack:channel:C0WATCH01');
    const rec = await call('cc_record_source_items', { items: [{ kind: 'message', externalId: 'C0WATCH01:1793822400.000100', occurredAt: '1793822400.000100', excerpt: 'Private Connect GA' }] });
    const r = await call('cc_record_brief_highlights', { summary: 'One relevant launch.', highlights: [{ title: 'Private Connect GA', relevance: 'high', reasons: ['ACME open item on Private Connect'], sourceItemIds: [rec.json.items[0].id] }] });
    expect(r.json).toMatchObject({ ok: true, n: 1 });
    expect(store.listBriefs()[0]).toMatchObject({ subscription: { kind: 'channel', ref: 'C0WATCH01' }, highlights: [{ suggestedAction: 'promote' }] });
    const parsed = parseHighlightsBlock('partial: read to x\nHIGHLIGHTS v1\n1793822400.000100|https://example.slack.com/x|Private Connect GA this week|matched=ACME|why=open item on Private Connect\n1793822500.000100|https://e/y|Second|matched=skills|why=Data 360', state.recorded);
    expect(parsed!.highlights[0]).toMatchObject({ title: 'Private Connect GA this week', relevance: 'high', sourceItemIds: [rec.json.items[0].id], reasons: ['open item on Private Connect', 'matched: ACME'] });
    expect(parsed!.summary).toBe('partial: read to x');
    // caps audit: every highlight line is kept (was the first 12); relevance falls with the order
    const lines = Array.from({ length: 15 }, (_, i) => `17938225${String(i).padStart(2, '0')}.000100|https://e/${i}|Highlight ${i}|why=x`).join('\n');
    const all = parseHighlightsBlock(`HIGHLIGHTS v1\n${lines}`, state.recorded)!;
    expect(all.highlights).toHaveLength(15);
    expect(all.highlights[14]).toMatchObject({ title: 'Highlight 14', relevance: 'low' });
  });
});

describe('content hash', () => {
  it('ignores transcription variance but sees real edits', () => {
    expect(contentHashOf({ excerpt: "Sure, I'll send the ACME demo deck tonight! 🙌" })).toBe(contentHashOf({ excerpt: 'sure  ill send the ACME demo deck tonight' }));
    expect(contentHashOf({ excerpt: 'send it Monday' })).not.toBe(contentHashOf({ excerpt: 'send it Tuesday' }));
  });
});

describe('redact', () => {
  it('masks credential-like text and is idempotent', () => {
    const s = 'Bearer abcdefghijklmnop123 and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmno, sk-ant-REDACTEDREDACTEDxx, 00DXX0000001234!AQEAQFAKEFAKEFAKEFAKEFAKE, postgres://u:secretpw@host/db, the password is hunter2, AKIAABCDEFGHIJKLMNOP';
    const r = redact(s);
    expect(r.text).not.toMatch(/abcdefghijklmnop123|eyJzdWIi|sk-ant-RE|AQEAQFAKE|secretpw|hunter2|AKIAABCDEFGH/);
    expect(r.kinds).toEqual(expect.arrayContaining(['bearer', 'jwt', 'api_key', 'sf_session', 'connection_string', 'password', 'aws_key']));
    expect(redact(r.text).text).toBe(r.text);
    expect(redact('let me pass on that, see the deck').redacted).toBe(false);
  });
});
