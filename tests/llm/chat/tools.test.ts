/**
 * The eleven tools' contracts and guardrails with fakes (no model): act's allow | stage | deny classes, nothing sends,
 * live reads through the runtime with their cost booked and long text paged (never clipped), plan → estimate → wait,
 * remember, help's playbooks, unknown arguments refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatPlan, Receipt } from '@/contract';
import { routeTurn } from '@/llm/chat/router';
import { actTargetNamed, callChatTool, CHAT_TOOLS, newToolState, pageText, type ChatToolCtx } from '@/llm/chat/tools';
import type { ChatHost, ChatRunStep, ChatUsageRecord } from '@/llm/chat/types';
import { MemorySpendStore, SpendGovernor } from '@/llm/spend';
import { classifyAct } from '@/server/chat/app-routes';
import { createChatHost } from '@/server/chat/host';
import type { MockDataSource } from '@/server/datasource/mock';
import { MockChatMemory } from '@/server/datasource/mock/chat-memory';
import { chatToolsFor } from '@/llm/chat/server';
import { personaOf, type ResolvedPersona } from '@/personas';
import { mockWith } from '../../chat/helpers';

let ds: MockDataSource;
beforeEach(() => {
  ds = mockWith();
});
afterEach(() => ds.dispose());

const ctxFor = (host: ChatHost, text: string, over: Partial<ChatToolCtx> = {}) => {
  const steps: ChatRunStep[] = [];
  const ctx: ChatToolCtx = { host, input: { threadId: 't1', messageId: 'm1', userMessageId: 'u1', text, context: [], model: 'haiku', signal: new AbortController().signal }, emit: (s) => void steps.push(s), state: newToolState(), signal: new AbortController().signal, route: routeTurn({ text }), ...over };
  return { ctx, steps };
};

describe('act: allow | stage | deny', () => {
  it('classifies: asked work-item actions run, settings stage, sending / budgets / unknown are denied', () => {
    expect(classifyAct('snooze', { userAsked: true }).class).toBe('allow');
    expect(classifyAct('snooze', { userAsked: false }).class).toBe('stage');
    expect(classifyAct('settings', { section: 'display', userAsked: true }).class).toBe('stage');
    expect(classifyAct('settings', { section: 'sending', userAsked: true })).toMatchObject({ class: 'deny', why: expect.stringMatching(/Settings ▸ Sending/) });
    expect(classifyAct('settings', { section: 'budgets', userAsked: true })).toMatchObject({ class: 'deny', why: expect.stringMatching(/never raises its own budget/) });
    expect(classifyAct('settings', { section: 'persona', userAsked: true }).class).toBe('deny');
    expect(classifyAct('send', { userAsked: true }).class).toBe('deny');
    expect(classifyAct('dispatch', { userAsked: true }).class).toBe('deny');
  });

  it('an asked snooze runs through the Apply path (actor chat) and returns the receipt; unasked, it is a card', async () => {
    const applied: string[] = [];
    const base = createChatHost(ds, { ...ds.be6.backend(), applyStaged: async (pid, d) => (applied.push(pid), (await ds.be6.apply(pid, d))?.receipt ?? null) }, () => ds.now());
    const item = (await ds.listItems({ query: { tab: 'all_open' } } as never)).items[0]!;
    const until = new Date(ds.now().getTime() + 3 * 3600_000).toISOString();
    const asked = ctxFor(base, `snooze ${item.title} until later`);
    const r = await callChatTool(asked.ctx, 'act', { op: 'snooze', itemId: item.id, until });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text)).toMatchObject({ done: true });
    expect(applied).toHaveLength(1);
    expect(asked.steps.find((s) => s.type === 'receipt')).toBeTruthy();
    expect((await ds.getItem({ params: { id: item.id } } as never)).item.state).toBe('snoozed');
    // the same action in a turn that did not ask for it (a lookup) stages a card instead
    const other = (await ds.listItems({ query: { tab: 'all_open' } } as never)).items.find((w) => w.id !== item.id)!;
    const unasked = ctxFor(base, 'what is on my list?');
    const s = await callChatTool(unasked.ctx, 'act', { op: 'pin', itemId: other.id });
    expect(JSON.parse(s.text)).toMatchObject({ staged: true });
    expect(applied).toHaveLength(1);
    expect(unasked.steps.find((x) => x.type === 'proposal')).toBeTruthy();
  });

  it('settings: an allowed section is a card; sending and budgets are refused before anything is staged', async () => {
    const host = createChatHost(ds, ds.be6.backend(), () => ds.now());
    const { ctx, steps } = ctxFor(host, 'turn off the morning brief');
    const deny = await callChatTool(ctx, 'act', { op: 'settings', section: 'sending', value: { dryRun: false } });
    expect(deny).toMatchObject({ ok: false });
    expect(deny.summary).toMatch(/Not mine to do/);
    expect(await callChatTool(ctx, 'act', { op: 'settings', section: 'budgets', value: { hardUsd: 99 } })).toMatchObject({ ok: false });
    expect(steps.filter((x) => x.type === 'proposal')).toHaveLength(0);
    const ok = await callChatTool(ctx, 'act', { op: 'settings', section: 'chat', value: { routing: 'sonnet' } });
    expect(JSON.parse(ok.text)).toMatchObject({ staged: true });
    expect((await ds.getSettings({} as never)).chat.routing).toBe('auto'); // not applied
  });
});

describe('act applies only on the item the turn names (W12-2, D-58 as amended)', () => {
  const hostWithApply = (applied: string[]) => createChatHost(ds, { ...ds.be6.backend(), applyStaged: async (pid, d) => (applied.push(pid), (await ds.be6.apply(pid, d))?.receipt ?? null) }, () => ds.now());

  it('done on an id the turn does not name is staged, even in an act turn', async () => {
    const applied: string[] = [];
    const host = hostWithApply(applied);
    const [named, other] = (await ds.listItems({ query: { tab: 'all_open' } } as never)).items;
    const { ctx, steps } = ctxFor(host, `mark ${named!.title} as done`);
    expect(ctx.route!.intent).toBe('act');
    const r = await callChatTool(ctx, 'act', { op: 'done', itemId: other!.id });
    expect(JSON.parse(r.text)).toMatchObject({ staged: true, why: expect.stringMatching(/staged for your Apply/) });
    expect(applied).toHaveLength(0);
    expect(steps.find((s) => s.type === 'proposal')).toBeTruthy();
    expect(steps.find((s) => s.type === 'receipt')).toBeUndefined();
    expect((await ds.getItem({ params: { id: other!.id } } as never)).item.state).not.toBe('done');
  });

  it('done on the named item applies with Undo; so does done on the message context item', async () => {
    const applied: string[] = [];
    const host = hostWithApply(applied);
    const [a, b] = (await ds.listItems({ query: { tab: 'all_open' } } as never)).items;
    const byTitle = ctxFor(host, `mark ${a!.title} as done`);
    const r = await callChatTool(byTitle.ctx, 'act', { op: 'done', itemId: a!.id });
    expect(JSON.parse(r.text)).toMatchObject({ done: true, note: expect.stringMatching(/Undo/) });
    expect(byTitle.steps.find((s) => s.type === 'receipt')).toBeTruthy();
    const steps: ChatRunStep[] = [];
    const ctx: ChatToolCtx = { ...ctxFor(host, 'mark this as done').ctx, emit: (s) => void steps.push(s) };
    ctx.input = { ...ctx.input, context: [{ type: 'work_item', id: b!.id, label: 'Looking at', via: 'auto' }] };
    const c = await callChatTool(ctx, 'act', { op: 'done', itemId: b!.id });
    expect(JSON.parse(c.text)).toMatchObject({ done: true });
    expect(applied).toHaveLength(2);
    expect(steps.find((s) => s.type === 'receipt')).toBeTruthy();
  });

  it('actTargetNamed: id, whole title or context item; a title fragment or another id is not a name', () => {
    expect(actTargetNamed({ text: 'done with wi_123', context: [] }, 'wi_123', null)).toBe(true);
    expect(actTargetNamed({ text: 'mark Send the ACME deck as done', context: [] }, 'wi_9', 'Send the ACME deck')).toBe(true);
    expect(actTargetNamed({ text: 'mark the deck as done', context: [] }, 'wi_9', 'Send the ACME deck')).toBe(false);
    // the title's own words, as people say them: at least two, and at least half
    expect(actTargetNamed({ text: 'snooze the Globex VDP update until 14:00', context: [] }, 'wi_9', 'Update the VDP for the Globex expansion')).toBe(true);
    expect(actTargetNamed({ text: 'snooze the Globex thing until 14:00', context: [] }, 'wi_9', 'Update the VDP for the Globex expansion')).toBe(false);
    expect(actTargetNamed({ text: 'snooze the ACME Phase 2 demo until 14:00', context: [] }, 'wi_9', 'Kick off the ACME Phase 2 demo-org build')).toBe(true);
    expect(actTargetNamed({ text: 'mark this done', context: [{ id: 'wi_9' }] }, 'wi_9', null)).toBe(true);
    expect(actTargetNamed({ text: 'mark this done', context: [{ id: 'wi_8' }] }, 'wi_9', null)).toBe(false);
  });
});

describe('nothing sends', () => {
  it('no tool, op or kind can send, post, dispatch or apply a proposal', () => {
    const surface = JSON.stringify(CHAT_TOOLS.map((t) => [t.name, Object.keys(t.shape), (t.shape as Record<string, { options?: unknown; _def?: { values?: unknown } }>).kind?._def?.values ?? null, (t.shape as Record<string, { _def?: { values?: unknown } }>).op?._def?.values ?? null]));
    expect(surface).not.toMatch(/"(send|post|dispatch|applyProposal|push|submit|publish)"/);
  });

  it('a draft stops in the Outbox as drafting; the host never sees a send call', async () => {
    const called: string[] = [];
    const real = createChatHost(ds, ds.be6.backend(), () => ds.now());
    const host = new Proxy(real, {
      get(t, k) {
        if (typeof k === 'string' && /send|dispatch|post|push/i.test(k)) throw new Error(`host.${k} must never be called`);
        const v = (t as unknown as Record<string, unknown>)[k as string];
        if (typeof v === 'function') called.push(String(k));
        return v;
      },
    }) as ChatHost;
    const { ctx } = ctxFor(host, 'draft a reply to #acme-ext');
    const r = await callChatTool(ctx, 'propose', { kind: 'draft', draft: { channel: 'slack', to: '#acme-ext', intent: 'say the demo moved', body: 'The demo moves to Thursday.' } });
    expect(r.ok).toBe(true);
    const draftId = JSON.parse(r.text).draftId as string;
    expect((await ds.getDraft({ params: { id: draftId } } as never)).status).toBe('drafting');
    expect(called).toContain('createDraft');
  });
});

describe('live reads through the connector runtime', () => {
  it('search slack: one relay read, its cost booked with the thread id; a long result is paged, never clipped', async () => {
    const usage: ChatUsageRecord[] = [];
    const big = `${'word '.repeat(7_998)}MIDDLE ${'more '.repeat(4_000)}END`; // 60,000 characters of prose (long runs look like tokens to the redactor)
    const liveRead = vi.fn(async () => ({ text: big, costUsd: 0.003, model: 'claude-haiku-5-5', inputTokens: 900, outputTokens: 40, ok: true }));
    const host = { ...createChatHost(ds, ds.be6.backend(), () => ds.now()), liveRead, recordUsage: async (u: ChatUsageRecord) => void usage.push(u) } as ChatHost;
    const spent: number[] = [];
    const { ctx, steps } = ctxFor(host, 'find the Globex pricing thread in slack', { spend: (u) => void spent.push(u) });
    const r = await callChatTool(ctx, 'search', { source: 'slack', query: 'in:#globex pricing' });
    expect(liveRead).toHaveBeenCalledWith('slack', 'slack_search_public_and_private', { query: 'in:#globex pricing' }, expect.anything());
    expect(usage).toEqual([expect.objectContaining({ threadId: 't1', messageId: 'm1', skill: 'relay:slack:slack_search_public_and_private', costUsd: 0.003 })]);
    expect(spent).toEqual([0.003]);
    expect(steps.find((s) => s.type === 'tool-result')).toMatchObject({ costUsd: 0.003 });
    expect(r.text).toMatch(/\[60000 characters; read the rest with the same call and offset=40000\]$/);
    const r2 = await callChatTool(ctx, 'search', { source: 'slack', query: 'in:#globex pricing', offset: 40_000 });
    expect(r2.text).toContain('END');
    expect(pageText(big).text.length + pageText(big, 40_000).text.length).toBe(big.length);
  });

  it('fetch slack takes a permalink or channel:ts; mock mode says live reads are not available', async () => {
    const liveRead = vi.fn(async () => ({ text: 'thread', costUsd: 0, ok: true }));
    const host = { ...createChatHost(ds, ds.be6.backend(), () => ds.now()), liveRead } as ChatHost;
    const { ctx } = ctxFor(host, 'read that thread');
    await callChatTool(ctx, 'fetch', { source: 'slack', ref: 'https://acme.slack.com/archives/C0123ABCD/p1731000000123456' });
    expect(liveRead).toHaveBeenLastCalledWith('slack', 'slack_read_thread', { channel_id: 'C0123ABCD', message_ts: '1731000000.123456' }, expect.anything());
    await callChatTool(ctx, 'fetch', { source: 'slack', ref: 'C0123ABCD:1731000000.123456' });
    expect(liveRead).toHaveBeenCalledTimes(2);
    const mock = ctxFor(createChatHost(ds, ds.be6.backend(), () => ds.now()), 'search slack');
    expect((await callChatTool(mock.ctx, 'search', { source: 'slack', query: 'pricing' })).summary).toBe('Slack search: not available here');
  });

  it('search ledger reads the scan ledger; unknown arguments are refused, never ignored', async () => {
    const host = createChatHost(ds, ds.be6.backend(), () => ds.now());
    const { ctx } = ctxFor(host, 'find the ACME demo');
    const r = await callChatTool(ctx, 'search', { source: 'ledger', query: 'ACME demo' });
    expect(r.ok).toBe(true);
    const bad = await callChatTool(ctx, 'query', { view: 'work_items', sql: 'select * from users' });
    expect(bad).toMatchObject({ ok: false, summary: 'Invalid arguments' });
    expect(bad.text).toMatch(/unknown sql/);
  });
});

describe('plan → estimate → wait', () => {
  const gov = () => new SpendGovernor(new MemorySpendStore({ now: () => new Date('2026-11-20T12:00:00Z') }));

  it('a plan without a research-class run is a line with its estimate; nothing waits', async () => {
    const waitPlan = vi.fn();
    const { ctx, steps } = ctxFor(createChatHost(ds, ds.be6.backend(), () => ds.now()), 'list my week', { gov: gov(), waitPlan });
    const r = await callChatTool(ctx, 'plan', { steps: [{ tool: 'query', what: 'Read this week’s meetings' }, { tool: 'query', what: 'Read the open items' }] });
    expect(r.ok).toBe(true);
    expect(waitPlan).not.toHaveBeenCalled();
    const plan = (steps.find((s) => s.type === 'plan') as { plan: ChatPlan }).plan;
    expect(plan).toMatchObject({ status: 'info', estimate: { basis: 'default' } });
    expect(plan.steps.every((s) => typeof s.estUsd === 'number')).toBe(true);
    expect(plan.estimate.p90).toBeGreaterThanOrEqual(plan.estimate.p50);
  });

  it('a research plan waits; Run approves the run, Edit returns the note, Skip leaves it unrun', async () => {
    for (const [answer, status, approved] of [
      ['run', 'run', true],
      ['edit', 'edited', false],
      ['skip', 'skipped', false],
    ] as const) {
      const { ctx, steps } = ctxFor(createChatHost(ds, ds.be6.backend(), () => ds.now()), 'have I done anything for Globex?', { gov: gov(), waitPlan: async () => ({ answer, ...(answer === 'edit' ? { note: 'only Slack' } : {}) }) });
      const r = await callChatTool(ctx, 'plan', { steps: [{ tool: 'run', run: 'research', what: 'Research Globex live' }] });
      const plans = steps.filter((s): s is { type: 'plan'; plan: ChatPlan } => s.type === 'plan').map((s) => s.plan);
      expect(plans.map((p) => p.status)).toEqual(['waiting', status]);
      expect(ctx.state.planApproved).toBe(approved);
      // the research step is priced from the research scope (history when there is one, the default table otherwise)
      expect(plans[0]!.steps[0]!.estUsd).toBeGreaterThan(0.1);
      if (answer === 'edit') expect(r.text).toMatch(/only Slack/);
    }
  });
});

describe('remember and help', () => {
  it('remember keeps a thread note or a pinned preference', async () => {
    const memory = new MockChatMemory(() => new Date('2026-11-20T12:00:00Z'));
    const host = { ...createChatHost(ds, ds.be6.backend(), () => ds.now()), memory } as ChatHost;
    const { ctx } = ctxFor(host, 'remember that: never draft in French');
    await callChatTool(ctx, 'remember', { text: 'The Globex sponsor is Dana', scope: 'thread' });
    await callChatTool(ctx, 'remember', { text: 'Never draft in French', scope: 'preference' });
    const all = await memory.list('t1');
    expect(all.map((e) => [e.kind, e.threadId, e.pinned])).toEqual([
      ['note', 't1', false],
      ['preference', null, true],
    ]);
    expect((await memory.list('other')).map((e) => e.kind)).toEqual(['preference']);
    // SEC-8: both record the user message the turn answers, so Settings shows the exact source
    expect(all.map((e) => memory.sourceMessageIdOf(e.id))).toEqual(['u1', 'u1']);
  });

  it('help returns what it can do, the catalogs and the playbooks on demand', async () => {
    const { ctx } = ctxFor(createChatHost(ds, ds.be6.backend(), () => ds.now()), 'what can you do?');
    expect((await callChatTool(ctx, 'help', {})).text).toMatch(/I never send, post, apply/);
    expect((await callChatTool(ctx, 'help', { topic: 'views' })).text).toMatch(/^- work_items: /m);
    expect((await callChatTool(ctx, 'help', { topic: 'dc' })).text).toMatch(/The DC comment is true/);
  });
});

describe("help serves the persona's playbooks (D-55, P31 eval note)", () => {
  const host = () => createChatHost(ds, ds.be6.backend(), () => ds.now());
  const se = personaOf({ persona: { id: 'se' } } as never);
  const ae = personaOf({ persona: { id: 'ae' } } as never);
  const aeWithDc = personaOf({ persona: { id: 'ae', features: { dealContributions: true } } } as never);
  const help = async (persona: ResolvedPersona | null | undefined, topic?: string) => {
    const { ctx, steps } = ctxFor(host(), 'how do I update a VDP?', { persona });
    const r = await callChatTool(ctx, 'help', topic ? { topic } : {});
    return { ...r, steps };
  };

  it("an AE asking for the vdp or dc playbook gets the plain 'not active for your role' answer, never the playbook", async () => {
    const vdp = await help(ae, 'vdp');
    expect(vdp.ok).toBe(true);
    expect(vdp.text).toBe('VDP is not active for your role, so there is no vdp playbook to read (Settings ▸ Role & rules lists it as available to activate).');
    expect(vdp.text).not.toBe((await help(se, 'vdp')).text);
    const dc = await help(ae, 'dc');
    expect(dc.text).toMatch(/^Deal contributions is not active for your role/);
    expect(dc.text).not.toMatch(/The DC comment is true/);
    expect(vdp.summary).toBe('Not active for your role');
    // a loading persona (null) gets neither
    for (const t of ['vdp', 'dc']) expect((await help(null, t)).text).toMatch(/is not active for your role/);
  });

  it('an SE gets both playbooks; an AE who activated deal contributions gets dc and still not vdp', async () => {
    expect((await help(se, 'dc')).text).toMatch(/The DC comment is true/);
    expect((await help(se, 'vdp')).text).not.toMatch(/not active for your role|No playbook/);
    expect((await help(aeWithDc, 'dc')).text).toMatch(/The DC comment is true/);
    expect((await help(aeWithDc, 'vdp')).text).toMatch(/^VDP is not active for your role/);
    for (const t of ['logging', 'lists']) expect((await help(ae, t)).text).not.toMatch(/not active for your role|No playbook/);
  });

  it("help with no topic lists the persona's topics and stage kinds", async () => {
    const a = (await help(ae)).text;
    expect(a).toMatch(/I never send, post, apply/);
    expect(a).toContain('Topics (help topic): pages, routes, stage_routes, views, and the playbooks logging, lists.');
    expect(a).not.toMatch(/\bVDP\b|\bDC\b/);
    const s = (await help(se)).text;
    expect(s).toContain('the playbooks dc, vdp, logging, lists.');
    expect(s).toContain('card edits, DC claims, time-row fixes, VDP changes, logging canvases, drafts for the Outbox');
    expect((await help(aeWithDc)).text).toContain('the playbooks dc, logging, lists.');
  });

  it("the description's playbook list is the persona's too", () => {
    const d = (p: ResolvedPersona | null | undefined) => chatToolsFor(p).find((t) => t.name === 'help')!.description;
    expect(d(ae)).toMatch(/: logging, lists\.$/);
    expect(d(aeWithDc)).toMatch(/: dc, logging, lists\.$/);
    expect(d(se)).toMatch(/: dc, vdp, logging, lists\.$/);
    expect(d(null)).toMatch(/: logging, lists\.$/);
  });
});

describe('a receipt from act carries Undo', () => {
  it('the receipt lines have audit ids', async () => {
    const host = createChatHost(ds, { ...ds.be6.backend(), applyStaged: async (pid, d) => (await ds.be6.apply(pid, d))?.receipt ?? null }, () => ds.now());
    const item = (await ds.listItems({ query: { tab: 'all_open' } } as never)).items[0]!;
    const { ctx, steps } = ctxFor(host, `mark ${item.title} as done`);
    await callChatTool(ctx, 'act', { op: 'done', itemId: item.id });
    const receipt = (steps.find((s) => s.type === 'receipt') as { receipt: Receipt }).receipt;
    expect(receipt.changes.length).toBeGreaterThan(0);
    expect(receipt.changes.every((c) => !!c.auditId)).toBe(true);
  });
});

describe("search, fetch, run, plan, propose and help describe only the persona's features (D-55, P31-3)", () => {
  const desc = (p: ResolvedPersona | null | undefined) => Object.fromEntries(chatToolsFor(p).filter((t) => ['search', 'fetch', 'run'].includes(t.name)).map((t) => [t.name, t.description]));
  const se = personaOf({ persona: { id: 'se' } } as never);
  const ae = personaOf({ persona: { id: 'ae' } } as never);

  it("an AE's catalog never names VDP; an SE's never names the forecast jobs", () => {
    for (const [name, d] of Object.entries(desc(ae))) expect(d, name).not.toMatch(/\bvdp|okta\b/i);
    expect(desc(ae).run).toMatch(/syncForecast\|checkMissingForecast\|retryJob/);
    for (const [name, d] of Object.entries(desc(se))) expect(d, name).not.toMatch(/Forecast/);
    expect(desc(se).search).toContain('vdp = VDPs by words');
    expect(desc(se).fetch).toContain('vdp (ref = a VDP slug');
    expect(desc(se).run).toMatch(/vdp_find_assets \{key or all\}.*vdp through Okta/);
    expect(desc(se).run).toContain('job {route: retryJob, id?}');
  });

  it('no persona (undefined) names every surface; a loading persona (null) none of the gated ones', () => {
    const all = desc(undefined);
    expect(all.search).toContain('vdp = VDPs by words');
    expect(all.run).toMatch(/vdp through Okta.*syncForecast\|checkMissingForecast\|retryJob/);
    for (const d of Object.values(desc(null))) expect(d).not.toMatch(/\bvdp|okta|Forecast\b/i);
  });

  it("plan, propose and help follow the persona too (P31 follow-up): an AE's never name VDP, an SE's keep it", () => {
    const three = (p: ResolvedPersona | null | undefined) => Object.fromEntries(chatToolsFor(p).filter((t) => ['plan', 'propose', 'help'].includes(t.name)).map((t) => [t.name, t.description]));
    const [a, s, all, loading] = [three(ae), three(se), three(undefined), three(null)];
    for (const d of [a, s, all, loading]) expect(Object.keys(d).sort()).toEqual(['help', 'plan', 'propose']);
    for (const [name, d] of Object.entries(a)) expect(d, name).not.toMatch(/\bvdp|okta\b/i);
    for (const [name, d] of Object.entries(loading)) expect(d, name).not.toMatch(/\bvdp|okta\b/i);
    for (const [name, d] of [...Object.entries(a), ...Object.entries(s)]) expect(d, name).not.toMatch(/syncForecast|checkMissingForecast/);
    expect(a.plan).toContain('(run research or read_in)');
    expect(a.help).toMatch(/playbook to read before that work: logging, lists\.$/); // no DC either: the AE preset has deal contributions off
    expect(a.propose).toContain('a draft reply, a logging canvas, a session link');
    expect(a.propose).toMatch(/draft = a Slack or email draft for the Outbox \{[^}]*\}; log_batch = /);
    for (const d of [s, all]) {
      expect(d.plan).toContain('(run research, read_in or vdp_find_assets)');
      expect(d.help).toContain('dc, vdp, logging, lists.');
      expect(d.propose).toContain('a draft reply, a VDP change, a logging canvas');
      expect(d.propose).toMatch(/; vdp = one VDP change \(update a field\), Applied on Activity ▸ VDP .*; use_case = a VDP use case /);
    }
  });

  it('plan, propose and help keep their shapes: an AE can still pass kind vdp or topic vdp (refused or empty by role at call time)', () => {
    const shape = (name: string) => Object.keys(chatToolsFor(ae).find((t) => t.name === name)!.shape);
    expect(shape('propose')).toContain('vdp');
    expect(shape('help')).toContain('topic');
  });

  it('the server gates are unchanged: the shapes still take vdp and the forecast jobs (refused by role at call time)', () => {
    const run = chatToolsFor(ae).find((t) => t.name === 'run')!;
    expect(Object.keys(run.shape)).toContain('route');
    const search = chatToolsFor(ae).find((t) => t.name === 'search')!;
    expect((search.shape as unknown as { source: { options: string[] } }).source.options).toContain('vdp');
  });
});
