/**
 * AUDIT: the scan run trace on the in-memory store (placeholders only). The runner records every tool call, what REC-1
 * recorded, the prompt size against the tripwire, each pass, the triage selection and every verdict (escalation
 * included); the store's writers record proposals and links. Ids, counts and short reasons only, never message text,
 * and a trace failure never changes a run.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { AgentSdkSkillRunner, type ScanSkillRunInput, type ScanSkillRunResultWithPasses } from '../../src/llm/skill-runner';
import { restrictedTools } from '../../src/llm/mcp-config';
import { FakeClock } from '../../src/scanner/runtime/clock';
import { slackRecallDefaults } from '../../src/scanner/runtime/connectors';
import { InMemoryScannerStore } from '../../src/scanner/store-memory';
import { cleanPayload, logFields, MemoryTraceSink, setTraceSink, trace, withTraceContext, annotateTraceContext, type TraceSink } from '../../src/scanner/trace';
import { keyFromUrl, passSkill, passSpendOf, splitByPasses } from '../../src/scanner/trace/queries';
import { PROFILE } from '../scanner/runtime/helpers/world';

import { escalateSteps, fakeCli, perma, replay, traversal, triageSteps, ts, WINDOW } from './fake-cli';

afterEach(() => void setTraceSink(null));

async function setup() {
  const store = new InMemoryScannerStore({ clock: new FakeClock(WINDOW.to), profile: { ...structuredClone(PROFILE), me: { ...structuredClone(PROFILE).me, slackId: 'U0ME00001' } } });
  const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: WINDOW });
  const context = await store.getContext({ connector: 'slack', scope: 'inbox' });
  const d = slackRecallDefaults({ CC_SLACK_TRIAGE: '1', CC_SLACK_ESCALATE: '1' });
  const input: ScanSkillRunInput = {
    skillPath: 'skills/scan-slack.md',
    model: 'claude-haiku-5-5',
    mcpServers: {},
    allowedTools: restrictedTools('slack').allowedTools,
    runId,
    context,
    maxTurns: 30,
    costCapUsd: 0.08,
    signal: new AbortController().signal,
    window: WINDOW,
    mode: 'incremental',
    ...(d.autoRecord ? { autoRecord: d.autoRecord } : {}),
    ...(d.triage ? { triage: d.triage('inbox', 'incremental') } : {}),
  };
  return { store, input, runId };
}

describe('scan run trace (runner + store)', () => {
  it('records the decision trail of a Slack run in order: tool calls, REC-1, prompt, passes, selection, verdicts, proposals', async () => {
    const sink = new MemoryTraceSink();
    setTraceSink(sink);
    const { store, input, runId } = await setup();
    const r = (await new AgentSdkSkillRunner({ queryFn: fakeCli({ traversal, triage: triageSteps, escalate: escalateSteps }, replay()) }).run(input, store)) as ScanSkillRunResultWithPasses;
    expect(r.ok).toBe(true);
    const ev = sink.of(runId);
    expect(ev.map((e) => e.seq)).toEqual(ev.map((_, i) => i + 1)); // gapless, ordered
    const kinds = new Set(ev.map((e) => e.kind));
    for (const k of ['tool_call', 'rec', 'prompt', 'pass', 'triage_select', 'verdict']) expect(kinds.has(k as never), k).toBe(true);

    // every Slack tool call, with its query, duration and result size; cc tools by their ids only
    const calls = ev.filter((e) => e.kind === 'tool_call');
    const slack = calls.filter((e) => e.payload.server === 'slack');
    expect(slack.map((e) => e.payload.tool)).toEqual(['slack_search_public_and_private', 'slack_search_public_and_private', 'slack_search_public_and_private', 'slack_read_thread']);
    expect((slack[0]!.payload.args as Record<string, unknown>).query).toBe('-from:<@U0ME00001>');
    expect(slack[0]!.payload.size).toBeGreaterThan(100);
    expect(typeof slack[0]!.payload.ms).toBe('number');
    const propose = calls.find((e) => e.payload.tool === 'cc_propose_item')!;
    expect(propose.payload.args).toEqual({ kind: 'ask', confidence: 'sure', evidenceN: 1 });

    // REC-1 per tool result
    const rec = ev.filter((e) => e.kind === 'rec');
    expect(rec.length).toBe(4);
    expect(rec.reduce((a, e) => a + Number(e.payload.recorded ?? 0), 0)).toBe(8);

    // prompt size against the tripwire, per pass
    const prompts = ev.filter((e) => e.kind === 'prompt');
    expect(prompts.map((e) => e.payload.pass)).toEqual(['traversal', 'triage', 'escalate']);
    expect(Number(prompts[0]!.payload.limit)).toBeGreaterThan(Number(prompts[0]!.payload.tokens));

    // passes: traversal, triage, escalate with outcome and cost
    expect(ev.filter((e) => e.kind === 'pass').map((e) => [e.payload.pass, e.payload.ok])).toEqual([
      ['traversal', true],
      ['triage', true],
      ['escalate', true],
    ]);

    // selection: the trivial thanks and the already-proposed ask are named, with why
    const thanks = store.getSourceItemByDedupe(`slack:D0DM00011:${ts(12)}`)!.id;
    const asked = store.getSourceItemByDedupe(`slack:D0DM00011:${ts(5)}`)!.id;
    const sel = ev.find((e) => e.kind === 'triage_select')!;
    expect(sel.payload).toMatchObject({ trivial: 1, handled: 1, needing: 6 });
    expect(sel.payload.trivialIds).toEqual([thanks]);
    expect(sel.payload.handledIds).toEqual([asked]);

    // one verdict per message that needed one, with its reason; the unsure one escalates, and the escalation is final
    const verdicts = ev.filter((e) => e.kind === 'verdict');
    const unsure = store.getSourceItemByDedupe(`slack:C0GDM0001:${ts(20)}`)!.id;
    const tri = verdicts.filter((e) => e.payload.pass === 'triage');
    expect(tri).toHaveLength(6);
    expect(tri.find((e) => e.sourceItemId === unsure)!.payload).toMatchObject({ v: 'unsure', why: 'who is you in the group DM', escalate: true, ref: `C0GDM0001:${ts(20)}` });
    expect(verdicts.find((e) => e.payload.pass === 'escalate')).toMatchObject({ sourceItemId: unsure, payload: { v: 'act', final: true, why: 'a direct question to me' } });

    // privacy: no message text anywhere in the trace
    const all = JSON.stringify(ev);
    expect(all).not.toContain('SECRET_TEXT_A');
    expect(all).not.toContain('SECRET_TEXT_B');
    expect(all).not.toContain('write access to the repo');
  });

  it('a trace failure never changes a run: a throwing sink, a throwing payload', async () => {
    const broken: TraceSink = {
      write() {
        throw new Error('sink down');
      },
      async flush() {
        throw new Error('sink down');
      },
    };
    setTraceSink(broken);
    const { store, input } = await setup();
    const r = (await new AgentSdkSkillRunner({ queryFn: fakeCli({ traversal, triage: triageSteps, escalate: escalateSteps }, replay()) }).run(input, store)) as ScanSkillRunResultWithPasses;
    expect(r.ok).toBe(true);
    expect(r.counts?.proposed).toBe(3);
    expect(() =>
      trace('00000000-0000-4000-8000-000000000001', 'plan', () => {
        throw new Error('bad payload');
      }),
    ).not.toThrow();
  });

  it('cleans payloads: credentials redacted, strings clipped, id lists kept up to 200', () => {
    const p = cleanPayload({ error: `token xoxb-1234567890-abcdefghij leaked ${'x'.repeat(400)}`, ids: Array.from({ length: 250 }, (_, i) => `id${i}`), list: Array.from({ length: 80 }, (_, i) => i), deep: { a: { b: { c: { d: { e: 1 } } } } } });
    expect(String(p.error)).not.toContain('xoxb-1234567890');
    expect(String(p.error).length).toBeLessThanOrEqual(160);
    expect((p.ids as string[]).length).toBe(200);
    expect((p.list as number[]).length).toBe(50);
    expect(JSON.stringify(p.deep)).toContain('[…]');
  });

  it('correlation context: job → run → connector → scope on every log line inside it', async () => {
    expect(logFields()).toEqual({});
    await withTraceContext({ jobId: 42, jobKind: 'scan.slack' }, async () => {
      await withTraceContext({ connector: 'slack', scope: 'inbox', budget: 'first_scan' }, async () => {
        annotateTraceContext({ runId: 'r-1' });
        await Promise.resolve();
        expect(logFields()).toEqual({ runId: 'r-1', jobId: 42, connector: 'slack', scope: 'inbox' });
      });
      expect(logFields()).toEqual({ jobId: 42 });
    });
  });

  it('reads source keys out of permalinks', () => {
    expect(keyFromUrl(perma('C0GDM0001', ts(20)))).toMatchObject({ dedupeKey: `slack:C0GDM0001:${ts(20)}`, channelId: 'C0GDM0001', ts: ts(20) });
    expect(keyFromUrl('https://org62.lightning.force.com/lightning/r/Event/00UXX0000000001AAA/view')).toEqual({ externalLike: '00UXX0000000001AAA' });
    expect(keyFromUrl('claude://code/continue?session=local_abc')).toEqual({ externalLike: 'abc' });
  });
});

describe("SPEND-1: a run's spend split by its passes", () => {
  const pass = (seq: number, p: Record<string, unknown>) => passSpendOf(seq, { ok: true, inputTokens: 100, outputTokens: 10, ...p });

  it('splits in order while the passes fit; a rounding remainder goes to the last pass, the rest stays on the booked model', () => {
    const passes = [pass(3, { pass: 'traversal', model: 'claude-haiku-5-5', costUsd: 0.002 }), pass(9, { pass: 'escalate', model: 'claude-sonnet-5-5', costUsd: 0.004 })];
    const exact = splitByPasses(0.0060000004, passes);
    expect(exact.parts.map((p) => [p.seq, p.model])).toEqual([[3, 'claude-haiku-5-5'], [9, 'claude-sonnet-5-5']]);
    expect(exact.restUsd).toBe(0);
    expect(exact.parts.reduce((a, p) => a + p.costUsd, 0)).toBeCloseTo(0.0060000004, 9);
    // a pass row was dropped (the trace is best effort): what no row covers stays on the booked model
    expect(splitByPasses(0.01, passes).restUsd).toBeCloseTo(0.004, 9);
    // a booking smaller than the next pass (a later recordSpend of a different call) never claims it
    expect(splitByPasses(0.003, passes)).toMatchObject({ parts: [{ seq: 3 }], restUsd: expect.closeTo(0.001, 9) });
    expect(splitByPasses(0.001, passes)).toEqual({ parts: [], restUsd: 0.001 });
  });

  it('reads a pass payload defensively and names the skill each pass ran', () => {
    expect(passSpendOf(1, { pass: 'triage', model: '', costUsd: 'x', inputTokens: -5, ok: false, errorClass: 'transient' })).toEqual({ seq: 1, pass: 'triage', model: null, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contentHash: null, ok: false, errorClass: 'transient' });
    expect(passSkill('traversal', 'scan-slack')).toBe('scan-slack');
    expect(passSkill('triage', 'scan-slack')).toBe('triage-slack');
    expect(passSkill('escalate', null)).toBe('triage-slack');
  });
});
