import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSseEvent, routes, Seed, type LiveEvent, type RouteKey } from '@/contract';
import { MockDataSource } from '@/server/datasource/mock';
import { buildDefaultScenario } from '@/mock/scenario';
import { scaleSeed, seedScale } from '@/mock/scale';
import { scaledUseCases } from '@/mock/vdp';
import { EXAMPLE_SEED_PATH, loadSeed } from '@/server/datasource/mock/seed-loader';
import { AppError } from '@/server/errors';
import type { DataSource } from '@/server/datasource/types';

const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const fast = { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 5, reevalMs: 5 };
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

let ds: MockDataSource;
beforeEach(() => {
  ds = new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed' });
});
afterEach(() => ds.dispose());

async function expectAppError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
  }
  throw new Error(`expected ${code}`);
}

describe('mock DataSource', () => {
  it('returns contract-valid payloads for every GET route', async () => {
    const sample: Record<string, unknown> = {
      getItem: { params: { id: 'w_dana_reply' } },
      getItemEvidence: { params: { id: 'w_dana_reply' } },
      getItemTrace: { params: { id: 'w_dana_reply' } },
      getResolutionCheck: { params: { id: 'w_dana_reply' } },
      getItemHistory: { params: { id: 'w_dana_reply' } },
      getItemNba: { params: { id: 'w_dana_reply' } },
      getInitiative: { params: { id: 'ini_acme_p2' } },
      getDraft: { params: { id: 'dr_dana' } },
      getDraftSource: { params: { id: 'dr_dana' } },
      getToolRun: { params: { id: 'tr_talktrack_acme' } },
      getAccount: { params: { accountId: 'acc_acme' } },
      getBrief: { params: { id: 'brief_team' } },
      getChatThread: { params: { id: 'thread_today' } },
      listItems: { query: { tab: 'all_open' } },
      getCalendar: { query: {} },
      getCalendarEvent: { params: { id: 'ev_acme_demo' } },
      getTime: { query: {} },
      getHistoryMonth: { query: {} },
      getHistoryDay: { params: { day: '2026-11-03' } },
      getScans: { query: { limit: 50 } },
      search: { query: { q: 'acme', limit: 20 } },
      getSince: { query: {} },
      getPeople: { query: { q: '', limit: 20 } },
      getReadIn: { params: { type: 'work_item', id: 'w_dana_reply' } },
      getVdpDetail: { query: { key: 'acme-corp-1' } },
      searchVdpCompanies: { query: { q: 'globex' } }, // D-69
      getForecastRecord: { params: { id: '00000000-0000-4000-a000-000000000001' } }, // lane A: the first placeholder Specialist Forecast
      getSpendAudit: { query: {} }, // lane D: Spend & decisions
      getSpendAuditDetail: { query: { day: '2026-11-05', offset: 0, limit: 20 } },
    };
    // 2026-11-13 (B2): the canvas review reads a staged logging canvas (the seed has none: stage one)
    const staged = await ds.stageLogBatch({ body: {} } as never);
    sample.getCanvasReview = { params: { id: staged.entity.draftIds[0] } };
    // D-70: the run's writes and one row's landings
    sample.getCanvasWrites = { params: { id: staged.entity.draftIds[0] } };
    sample.getRecordLandings = { query: { kind: 'activity_event', id: 'ac_tue_globex' } };
    for (const key of Object.keys(routes) as RouteKey[]) {
      const def = routes[key];
      if (def.method !== 'GET' || 'stream' in def) continue;
      const out = await (ds[key] as (i: unknown) => Promise<unknown>).call(ds, sample[key] ?? {});
      const r = def.response.safeParse(out);
      if (!r.success) console.error(key, r.error.issues.slice(0, 3));
      expect(r.success, key).toBe(true);
    }
  });

  it('Today has 3 NBA cards, a missed meeting, rail lanes and nav counts', async () => {
    const t = await ds.getToday({} as never);
    expect(t.nowStack.cards).toHaveLength(3);
    expect(t.nowStack.cards.map((c) => c.item.id)).toEqual(['w_acme_build', 'w_dana_reply', 'w_globex_sow']);
    expect(t.spine.events.some((e) => e.attendance === 'missed')).toBe(true);
    expect(t.rail.map((l) => l.lane)).toEqual(['since_you_left', 'waiting_on_you', 'agents', 'waiting_on_others', 'closed_for_you', 'health', 'briefs']);
    expect(t.rail.find((l) => l.lane === 'since_you_left')!.visible).toBe(true);
    expect(t.rail.find((l) => l.lane === 'closed_for_you')!.entries.every((e) => e.action?.auditId)).toBe(true);
    expect(t.shelves.promises[0].item.title).toMatch(/Beacon/);
    expect(t.nowStack.rerankReady).toBe(0);
    expect(t.dryRun).toBe(true);
  });

  it('stale ifVersion → 409 conflict with the current entity', async () => {
    const r1 = await ds.patchItem({ params: { id: 'w_dana_reply' }, body: { ifVersion: 1, patch: { notes: 'first' } } });
    expect(r1.entity.version).toBe(2);
    const err = await expectAppError(ds.patchItem({ params: { id: 'w_dana_reply' }, body: { ifVersion: 1, patch: { notes: 'stale' } } }), 'conflict');
    expect((err.details as { current: { version: number; notes: string } }).current.version).toBe(2);
    expect(err.status).toBe(409);
  });

  it('undo restores state; undoing the undo is redo', async () => {
    const done = await ds.itemAction({ params: { id: 'w_dana_reply', verb: 'done' }, body: { ifVersion: 1 } });
    expect(done.entity.state).toBe('done');
    expect(done.entity.resolution).toBe('done_by_me');
    const undo = await ds.undoAudit({ params: { id: done.auditId! }, body: {} });
    const after = (await ds.getItem({ params: { id: 'w_dana_reply' } })).item;
    expect(after.state).toBe('open');
    expect(after.resolution).toBeNull();
    expect(after.version).toBe(3);
    expect(undo.receipt?.changes.some((c) => c.field === 'state' && c.after === 'open')).toBe(true);
    await expectAppError(ds.undoAudit({ params: { id: done.auditId! }, body: {} }), 'validation'); // already undone
    await ds.undoAudit({ params: { id: undo.auditId! }, body: {} }); // redo
    expect((await ds.getItem({ params: { id: 'w_dana_reply' } })).item.state).toBe('done');
  });

  it('undo of an engine close (Closed for you) reopens the item', async () => {
    const t = await ds.getToday({} as never);
    const entry = t.rail.find((l) => l.lane === 'closed_for_you')!.entries.find((e) => e.id === 'w_umbrella_hipaa')!;
    await ds.undoAudit({ params: { id: entry.action!.auditId! }, body: {} });
    expect((await ds.getItem({ params: { id: 'w_umbrella_hipaa' } })).item.state).toBe('open');
  });

  it('an engine write to a user-locked field becomes a proposal', async () => {
    await ds.patchItem({ params: { id: 'w_initech_prep' }, body: { ifVersion: 1, patch: { title: 'My own title' } } });
    const r = ds.engineUpdateItem('w_initech_prep', { title: 'Engine title', purpose: 'Engine purpose' }, 'New info from Peter');
    expect(r.applied).toEqual(['purpose']);
    expect(r.proposalIds).toHaveLength(1);
    const detail = await ds.getItem({ params: { id: 'w_initech_prep' } });
    expect(detail.item.title).toBe('My own title');
    expect(detail.item.purpose).toBe('Engine purpose');
    expect(detail.proposals[0].changes[0]).toMatchObject({ field: 'title', before: 'My own title', after: 'Engine title' });
    const applied = await ds.applyProposal({ params: { id: r.proposalIds[0] }, body: {} });
    expect(applied.entity.status).toBe('applied');
    expect((await ds.getItem({ params: { id: 'w_initech_prep' } })).item.title).toBe('Engine title');
  });

  it('new info on a user-touched draft proposes; on an untouched draft it revises in place', async () => {
    // dr_dana is untouched → revised in place + update strip
    ds.engineReviseDraft('nba_dana', 'Pricing next steps follow.', 'Dana replied', { kind: 'slack', label: '#acme-ext' });
    const dana = await ds.getItemNba({ params: { id: 'w_dana_reply' } });
    expect(dana.nba?.update?.kind).toBe('revised');
    expect(dana.draft?.plainText).toContain('Pricing next steps follow.');
    // dr_globex_sow is user-touched → proposal, body unchanged
    const before = (await ds.getDraft({ params: { id: 'dr_globex_sow' } })).plainText;
    ds.engineReviseDraft('nba_globex_sow', 'One more line.', 'Marcus replied', undefined);
    const sow = await ds.getItemNba({ params: { id: 'w_globex_sow' } });
    expect(sow.draft?.plainText).toBe(before);
    expect(sow.nba?.update?.kind).toBe('proposal');
    expect(sow.proposals.some((p) => p.entity.type === 'draft' && p.textDiff?.some((d) => d.op === 'insert'))).toBe(true);
  });

  it('autosave marks the draft user-touched and coalesces audit entries', async () => {
    const d = await ds.getDraft({ params: { id: 'dr_dana' } });
    const doc = { type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited *by me*' }] }] };
    const a = await ds.patchDraft({ params: { id: d.id }, body: { ifVersion: d.version, doc } });
    const b = await ds.patchDraft({ params: { id: d.id }, body: { ifVersion: a.entity.version, doc: { ...doc, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited again' }] }] } } });
    expect(b.entity.userTouched).toBe(true);
    expect(b.entity.rendered.slack_mrkdwn?.body).toBe('Edited again');
    expect(b.auditId).toBe(a.auditId);
  });

  it('dry-run dispatch renders the payload and never calls out', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const d = await ds.getDraft({ params: { id: 'dr_globex_sow' } });
    const preview = await ds.previewDraft({ params: { id: d.id }, body: { mode: 'send' } });
    expect(preview.dryRun).toBe(true);
    expect(preview.payload).toMatchObject({ api: 'gmail.users.messages.send', subject: 'Re: Revised SOW pricing' });
    expect(String(preview.payload.html)).toMatch(/<p[ >]/); // src/lib/compose email HTML (inline-styled <p>)
    await expectAppError(ds.dispatchDraft({ params: { id: d.id }, body: { ifVersion: d.version, mode: 'send', confirmToken: 'forged' } }), 'validation');
    const res = await ds.dispatchDraft({ params: { id: d.id }, body: { ifVersion: d.version, mode: 'send', confirmToken: preview.confirmToken } });
    expect(res.dryRun).toBe(true);
    expect(res.attempt.outcome).toBe('rendered');
    expect(res.draft.status).toBe(d.status);
    await tick();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('policy preview shows the re-rank; apply re-ranks deterministically and is undoable', async () => {
    const s = await ds.getSettings({} as never);
    const weights = { ...s.policy.weights, customer_facing: 0, meeting_proximity: 0, lead_time: 0, manager_ask: 10 };
    const preview = await ds.previewPolicy({ body: { weights } });
    expect(preview.basedOnVersion).toBe(3);
    expect(preview.after[0].workItemId).toBe('w_priya_forecast');
    expect(preview.changedCount).toBeGreaterThan(0);
    const again = await ds.previewPolicy({ body: { weights } });
    expect(again.after.map((r) => r.workItemId)).toEqual(preview.after.map((r) => r.workItemId));
    const applied = await ds.applyPolicy({ body: { ifVersion: 3, weights, rules: s.policy.rules, note: 'test' } });
    expect(applied.entity.version).toBe(4);
    expect(applied.receipt?.changes.some((c) => c.field === 'rank')).toBe(true);
    const today = await ds.getToday({} as never);
    expect(today.nowStack.cards[0].item.id).toBe('w_priya_forecast');
    expect((await ds.getPolicyVersions({} as never)).current).toBe(4);
    await expectAppError(ds.applyPolicy({ body: { ifVersion: 3, weights, rules: s.policy.rules } }), 'conflict');
    await ds.undoAudit({ params: { id: applied.auditId! }, body: {} });
    expect((await ds.getSettings({} as never)).policy.version).toBe(3);
    expect((await ds.getToday({} as never)).nowStack.cards[0].item.id).toBe('w_acme_build');
  });

  it('capture saves instantly; enrichment chips + NBA arrive later via live events', async () => {
    const events: LiveEvent[] = [];
    const off = ds.bus.subscribe((e) => events.push(e));
    const r = await ds.captureItem({ body: { text: 'Talk to Leo about the NCE open questions ~20m' } });
    expect(r.entity.enrichment?.status).toBe('enriching');
    expect(r.entity.effort.youMin).toBe(20);
    await tick();
    const item = (await ds.getItem({ params: { id: r.entity.id } })).item;
    expect(item.enrichment?.status).toBe('done');
    expect(item.enrichment?.chips.length).toBeGreaterThan(0);
    expect(item.nbaId).toBeTruthy();
    expect(events.some((e) => e.reason === 'item.enrich' && e.topic === 'item' && e.ids.includes(r.entity.id))).toBe(true);
    expect((await ds.getToday({} as never)).nowStack.rerankReady).toBeGreaterThanOrEqual(0);
    off();
  });

  it('resolve: handed_off needs a person and makes me a watcher (R-UI-22)', async () => {
    await expectAppError(ds.itemAction({ params: { id: 'w_initech_prep', verb: 'resolve' }, body: { ifVersion: 1, resolution: 'handed_off' } }), 'validation');
    const r = await ds.itemAction({ params: { id: 'w_initech_prep', verb: 'resolve' }, body: { ifVersion: 1, resolution: 'handed_off', detail: { personId: 'p_kim' } } });
    expect(r.entity).toMatchObject({ state: 'done', resolution: 'handed_off', involvement: 'watcher' });
    expect(r.entity.resolutionDetail).toMatchObject({ personName: 'Kim Tran', inferred: false });
    expect(r.entity.owner?.name).toBe('Kim Tran');
  });

  it('scenario seek fires the timed events (UI-SPEC §15 + loop-back)', async () => {
    const status = await ds.controlScenario({ body: { action: 'seek', seconds: 200 } });
    // the seed's 8 steps, plus the live pass's arrivals (docs/UX.md "Live updates"): placeholders, no canvas in this seed
    expect(status.fired.filter((id) => !id.startsWith('live-'))).toHaveLength(8);
    expect(status.fired.filter((id) => id.startsWith('live-')).sort()).toEqual(['live-draft-arrives', 'live-draft-sent-elsewhere', 'live-needs-row-arrives', 'live-run-progresses', 'live-run-starts', 'live-suggestion-arrives']);
    expect(status.state).toBe('finished');
    // a new draft came in (with its task), a suggestion, a Needs-you row and a run; another draft was sent elsewhere
    const outbox = await ds.getOutbox({} as never);
    const drafts = outbox.groups.flatMap((g) => g.items.map((i) => i.draft));
    expect(drafts.find((d) => d.id === 'd_live_arrival')).toMatchObject({ status: 'ready', workItemId: 'w_live_arrival' });
    expect((await ds.getItem({ params: { id: 'w_live_suggestion' } })).item.state).toBe('suggested');
    expect((await ds.getAgents({} as never)).runs.find((r) => r.id === 'run_live_arrival')?.state).toBe('done_review');
    expect(drafts.find((d) => d.id === 'dr_chat_initech')?.status).toBe('sent');
    const agents = await ds.getAgents({} as never);
    expect(agents.runs.find((r) => r.id === 'run_acme_build')?.state).toBe('waiting_on_you');
    expect((await ds.getItem({ params: { id: 'w_acme_build' } })).item.state).toBe('waiting_on_me');
    expect((await ds.getItem({ params: { id: 'w_acme_onepager' } })).item.state).toBe('done');
    expect((await ds.getItem({ params: { id: 'w_umbrella_deck' } })).item.state).toBe('in_progress');
    expect((await ds.getItem({ params: { id: 'w_acme_recap' } })).item.state).toBe('reopened');
    const health = await ds.getHealth({} as never);
    expect(health.connectors.find((c) => c.id === 'gmail')?.state).toBe('auth_needed');
    expect((await ds.getItem({ params: { id: 'w_globex_sow' } })).item.stale?.connectorId).toBe('gmail');
    const today = await ds.getToday({} as never);
    expect(today.nowStack.rerankReady).toBeGreaterThan(0);
    const loop = (await ds.getItem({ params: { id: 'w_initech_security' } })).item;
    expect(loop).toMatchObject({ state: 'reopened', involvement: 'owner', resolution: null });
    expect(loop.loopedBackIn?.byPersonName).toBe('Peter Gibbons');
    // reset restores the seed
    await ds.controlScenario({ body: { action: 'reset' } });
    expect((await ds.getItem({ params: { id: 'w_acme_onepager' } })).item.state).toBe('open');
  });

  it('derives a default scenario when the seed has none', () => {
    const noScenario = new MockDataSource({ seed: { ...structuredClone(seed), scenario: undefined }, delays: fast, autoplay: false, clockMode: 'seed' });
    const events = buildDefaultScenario(noScenario.store);
    expect(events.map((e) => e.at)).toEqual([20, 40, 60, 80, 100, 120, 140, 160]);
    expect(noScenario.scenario.status().source).toBe('default');
    noScenario.dispose();
  });

  it('chat streams every event type; the receipt is a real, undoable change', async () => {
    const seen: ChatSseEvent[] = [];
    for await (const ev of ds.chat({ body: { text: 'good morning', context: [] }, signal: new AbortController().signal })) {
      expect(ChatSseEvent.safeParse(ev).success).toBe(true);
      seen.push(ev);
    }
    const types = new Set(seen.map((e) => e.type));
    for (const t of ['text-delta', 'tool-start', 'tool-result', 'receipt', 'proposal', 'resource', 'done']) expect(types.has(t as never), t).toBe(true);
    const receipt = seen.find((e) => e.type === 'receipt');
    if (receipt?.type !== 'receipt') throw new Error('no receipt');
    const change = receipt.receipt.changes[0];
    const target = change.entity.id;
    expect((await ds.getItem({ params: { id: target } })).item.notes).toContain('Discussed in chat');
    await ds.undoAudit({ params: { id: change.auditId }, body: {} });
    expect((await ds.getItem({ params: { id: target } })).item.notes).not.toContain('Discussed in chat');
    const thread = await ds.getChatThread({ params: { id: 'thread_today' } });
    expect(thread.messages.at(-1)?.role).toBe('assistant');
  });

  it('chat "do X first" moves the item to #1 with a receipt', async () => {
    const seen: ChatSseEvent[] = [];
    for await (const ev of ds.chat({ body: { text: 'do the Initech prep first', context: [{ type: 'work_item', id: 'w_initech_prep', label: 'Prep Initech' }] }, signal: new AbortController().signal })) seen.push(ev);
    expect(seen.some((e) => e.type === 'receipt')).toBe(true);
    expect((await ds.getToday({} as never)).nowStack.cards[0].item.id).toBe('w_initech_prep');
  });

  it('chat policy proposals apply through POST /proposals/:id/apply', async () => {
    const seen: ChatSseEvent[] = [];
    for await (const ev of ds.chat({ body: { text: 'customer work matters more, change my policy', context: [] }, signal: new AbortController().signal })) seen.push(ev);
    const p = seen.find((e) => e.type === 'proposal');
    if (p?.type !== 'proposal') throw new Error('no proposal');
    await ds.applyProposal({ params: { id: p.id }, body: {} });
    const s = await ds.getSettings({} as never);
    expect(s.policy.version).toBe(4);
    expect(s.policy.weights.customer_facing).toBe(5);
  });

  it('tool runs progress to a link; down tools fail with upstream_unavailable', async () => {
    const r = await ds.startToolRun({ params: { id: 'talk-track' }, body: { inputs: { customer: 'Hooli', name: 'Hooli NCE scoping' }, workItemId: 'w_hooli_talktrack' } });
    expect(r.entity.status).toBe('queued');
    // Poll instead of a fixed sleep: under a loaded full-suite run the mock timer can lag.
    let run = await ds.getToolRun({ params: { id: r.entity.id } });
    for (let i = 0; i < 100 && (run.status === 'queued' || run.status === 'starting' || run.status === 'running'); i++) {
      await tick(50);
      run = await ds.getToolRun({ params: { id: r.entity.id } });
    }
    expect(run.status).toBe('succeeded');
    expect(run.linkUrl).toContain(r.entity.id);
    await expectAppError(ds.startToolRun({ params: { id: 'pulse-footprint' }, body: { inputs: { orgId: 'x' } } }), 'upstream_unavailable');
    await expectAppError(ds.startToolRun({ params: { id: 'talk-track' }, body: { inputs: {} } }), 'validation');
  });

  it('launching a Claude session returns a claude:// deep link tagged with the item', async () => {
    const r = await ds.launchAgent({ body: { workItemId: 'w_hooli_talktrack' } });
    expect(r.url).toMatch(/^claude:\/\/code\/new\?folder=.+&q=/);
    expect(decodeURIComponent(r.url)).toContain('[cc:w_hooli_talktrack]');
    expect(r.run.state).toBe('queued');
  });

  it('missed-opp claim adds a DC request (a task only when the app does not know the opp); triage mapping needs a choice', async () => {
    const r = await ds.claimMissed({ params: { id: 'mo_globex_renew' }, body: {} });
    expect(r.entity.status).toBe('claimed');
    expect((await ds.listDcRequests({} as never)).requests.find((x) => x.id === r.entity.dcRequestId)).toMatchObject({ oppId: 'opp_globex_renew', splitPercent: 100, kind: 'add', stage: 'waiting' });
    // the fallback: an opp the app doesn't have (a finding with no oppId) is still a task to add the DC by hand
    const unknown = (await ds.getMissed({} as never)).missed.find((m) => m.status === 'new' && !m.oppId)!;
    const t = await ds.claimMissed({ params: { id: unknown.id }, body: {} });
    expect((await ds.getItem({ params: { id: t.entity.claimedWorkItemId! } })).item.title).toMatch(/DC/);
    await expectAppError(ds.acceptTriage({ params: { id: 'map_falcon' }, body: {} }), 'validation');
    const m = await ds.acceptTriage({ params: { id: 'map_falcon' }, body: { choiceId: 'c_acme' } });
    expect(m.entity.mapping?.status).toBe('answered');
  });

  it('turning dry-run off needs an explicit confirm', async () => {
    const s = await ds.getSettings({} as never);
    await expectAppError(ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { dryRun: false } } }), 'validation');
    const r = await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { dryRun: false }, confirm: true } });
    expect(r.entity.sending.dryRun).toBe(false);
  });

  it('implements every route method', () => {
    for (const key of Object.keys(routes) as RouteKey[]) expect(typeof (ds as unknown as DataSource)[key], key).toBe('function');
  });
});

describe('smoke at scale (C9, src/mock/scale.ts)', () => {
  it('scale 1 (the default) is the seed itself; the loader is unchanged without CC_SEED_SCALE', () => {
    expect(seedScale({})).toBe(1);
    expect(seedScale({ CC_SEED_SCALE: 'x' })).toBe(1);
    expect(scaleSeed(seed, 1)).toBe(seed);
    const plain = loadSeed({ path: EXAMPLE_SEED_PATH, rebase: false }).seed;
    expect(JSON.stringify(plain)).toBe(JSON.stringify(seed));
    vi.stubEnv('CC_SEED_SCALE', '1');
    try {
      expect(JSON.stringify(loadSeed({ path: EXAMPLE_SEED_PATH, rebase: false }).seed)).toBe(JSON.stringify(seed));
    } finally {
      vi.unstubAllEnvs();
    }
    expect(scaledUseCases(3)).toEqual([]);
  });

  it('scale 7: the expected counts, deterministic, placeholders only', () => {
    const big = scaleSeed(seed, 7);
    expect(() => Seed.parse(big)).not.toThrow();
    expect(JSON.stringify(scaleSeed(seed, 7))).toBe(JSON.stringify(big));
    expect(big.activity).toHaveLength(seed.activity.length * 7);
    expect(big.workItems.length).toBeGreaterThanOrEqual(Math.round(seed.workItems.length * 3.5) - 2);
    const copies = big.activity.filter((a) => a.id.includes('_x'));
    const asOf = Date.parse(seed.meta.asOf);
    expect(Math.min(...copies.map((a) => Date.parse(a.start)))).toBeGreaterThan(asOf - 43 * 86_400_000);
    const by = (f: (a: (typeof copies)[number]) => boolean) => copies.filter(f).length;
    expect(by((a) => a.status === 'needs_input' && (a.suggestion?.confidence ?? 0) > 0.8)).toBeGreaterThan(5);
    expect(by((a) => a.status === 'needs_input' && (a.suggestion?.confidence ?? 1) < 0.6)).toBeGreaterThan(5);
    expect(by((a) => a.status === 'needs_input' && !a.suggestion && !a.oppId)).toBeGreaterThan(5);
    expect(by((a) => a.taskType === null)).toBeGreaterThan(5);
    expect(by((a) => a.internal)).toBeGreaterThan(5);
    expect(by((a) => a.status === 'synced_to_canvas')).toBeGreaterThan(1);
    expect(by((a) => a.status === 'verify_failed' && a.issues.some((i) => i.startsWith('Not in Org62')))).toBe(1);
    const asks = big.workItems.filter((w) => w.kind === 'ask');
    expect(asks.filter((w) => w.title.startsWith('FYI: ')).length).toBeGreaterThan(2);
    expect(asks.filter((w) => !w.title.startsWith('FYI: ')).length).toBeGreaterThan(asks.length / 2);
    // placeholders only: every id derives from an example id, every name is an example name, every opp an example opp
    const ids = new Set([...seed.activity, ...seed.workItems].map((x) => x.id));
    for (const x of [...big.activity, ...big.workItems]) expect(ids.has(x.id.replace(/_x\d+$/, '')), x.id).toBe(true);
    const names = new Set(JSON.stringify(seed).match(/"name":"[^"]*"/g));
    for (const nm of JSON.stringify(big).match(/"name":"[^"]*"/g) ?? []) expect(names.has(nm), nm).toBe(true);
    for (const o of big.activity.flatMap((a) => [a.oppId, a.suggestion?.oppId]).filter(Boolean)) expect(seed.opps.some((p) => p.id === o)).toBe(true);
  });

  it('C6: scale 7 carries five logging batches for To log ▸ Sending (2 in flight, 3 finished); scale 1 has none', async () => {
    expect(scaleSeed(seed, 1).drafts.some((d) => d.id.startsWith('dr_scale_batch_'))).toBe(false);
    const big = scaleSeed(seed, 7);
    expect(big.drafts.filter((d) => d.id.startsWith('dr_scale_batch_')).map((d) => d.status)).toEqual(['ready', 'sent', 'verified', 'verified', 'verified']);
    const scaled = new MockDataSource({ seed: structuredClone(big), delays: fast, autoplay: false, clockMode: 'seed' });
    try {
      const week = await scaled.getTime({ query: { week: undefined } } as never);
      const { sendingOf } = await import('@/components/time/sending-derive');
      const { needsRelog } = await import('@/engines/activity/org62-check');
      const notFound = big.activity.filter((a) => needsRelog(a));
      const m = sendingOf({ canvases: week.logCanvases, notFound, weekStart: week.weekStart });
      const ours = m.batches.filter((b) => b.canvas.draftId.startsWith('dr_scale_batch_'));
      expect(ours.map((b) => b.canvas.state)).toEqual(['pending', 'applied']);
      expect(ours[0]!.next).toBe('apply');
      expect(ours[1]!.checked).toEqual({ n: 4, of: 6 });
      expect(ours[1]!.notFound).toHaveLength(2);
      expect(m.finishedThisWeek).toBeGreaterThanOrEqual(3);
    } finally {
      scaled.dispose();
    }
  });

  it('scale ≥ 4 gives the VDP page 60+ items to fix (placeholder use cases)', () => {
    vi.stubEnv('CC_SEED_SCALE', '4');
    const big = new MockDataSource({ seed: scaleSeed(structuredClone(seed), 4), delays: fast, autoplay: false, clockMode: 'seed' });
    try {
      expect(big.vdpHome()?.summary.appCanFix ?? 0).toBeGreaterThanOrEqual(60);
      expect(scaledUseCases(4).every((u) => /^Placeholder use case \d+$/.test(u.title ?? ''))).toBe(true);
    } finally {
      big.dispose();
      vi.unstubAllEnvs();
    }
  });
});
