/**
 * Today against the mock DataSource (placeholder seed): the payload the page builds on, the reopened
 * items the 12-row "more today" window leaves out (why the page also reads /items?tab=all_open), and
 * the stable order holding through the scenario.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Seed, TodayPayload } from '@/contract';
import { MockDataSource } from '@/server/datasource/mock';
import { claudeIntent, isActionable, isFreshArrival, reconcileOrder } from '@/components/today/model';

const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const fast = { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 5, reevalMs: 5 };

let ds: MockDataSource;
beforeEach(() => {
  ds = new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed' });
});
afterEach(() => ds.dispose());

const today = async () => TodayPayload.parse(await ds.getToday({} as never));

describe('Today on the mock', () => {
  it('serves three actionable NOW cards and a waiting-on-you rail lane', async () => {
    const t = await today();
    expect(t.nowStack.cards).toHaveLength(3);
    expect(t.nowStack.cards.every((c) => isActionable(c.item))).toBe(true);
    expect(t.rail.some((l) => l.visible && l.lane === 'waiting_on_you' && l.entries.length > 0)).toBe(true);
  });

  it('Start in Claude: the NBA link is a new launch unless the run is an existing session', async () => {
    const t = await today();
    for (const c of t.nowStack.cards.filter((x) => x.nba?.verb === 'start_in_claude')) {
      const intent = claudeIntent(c, c.nba?.claudeLaunch?.url ?? null);
      if (c.run?.kind === 'claude_session' && c.run.deepLink?.startsWith('claude://code/continue')) expect(intent.kind).toBe('open');
      else expect(intent.kind).toBe('launch');
    }
  });

  it('keeps the shown Top 3 through the scenario; only an explicit re-rank reorders', async () => {
    const first = (await today()).nowStack.cards.map((c) => c.item.id);
    await ds.controlScenario({ body: { action: 'seek', seconds: 165 } } as never);
    const later = await today();
    const server = later.nowStack.cards.filter((c) => isActionable(c.item)).map((c) => c.item.id);
    const shown = reconcileOrder({ prev: first, server, max: 3 }).order;
    // Every card still on the server keeps its slot.
    for (const id of shown) if (first.includes(id)) expect(shown.indexOf(id)).toBe(first.filter((x) => shown.includes(x)).indexOf(id));
    expect(later.nowStack.rerankReady).toBeGreaterThanOrEqual(0);
  });

  it('a reopened item can sit outside the more-today window; /items?tab=all_open has it', async () => {
    const start = await today();
    await ds.controlScenario({ body: { action: 'seek', seconds: 130 } } as never);
    const t = await today();
    const listed = new Set([...t.nowStack.cards.map((c) => c.item.id), ...t.moreToday.items.map((i) => i.id)]);
    const open = await ds.listItems({ query: { tab: 'all_open' } } as never);
    const reopened = open.items.filter((i) => i.state === 'reopened');
    // The scenario's reopen happened after the page opened: it is a fresh arrival ("n new ↓").
    const fresh = reopened.filter((r) => isFreshArrival(r, start.now));
    expect(fresh.length).toBeGreaterThan(0);
    for (const r of reopened) if (!listed.has(r.id)) expect(isActionable(r)).toBe(true); // appended by the page
  });
});
