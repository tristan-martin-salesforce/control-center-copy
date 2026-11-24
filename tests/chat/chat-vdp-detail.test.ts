/**
 * The Assistant and an open VDP (Time ▸ VDP details): with the VDP as "Looking at", "what use cases and assets does it
 * have?" reads `read vdp_detail` and answers from it (use cases with what is missing, the assets to add with their
 * links, the steps in order); "go back and find everything" shows a plan, and on Run starts Find assets (`run
 * vdp_find_assets`) and links the VDP's details. The vdp_detail view fits the read budget and keeps every open candidate. Mock DataSource, fake model.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { vdpHrefFor } from '@/contract';
import { CHAT_ALLOWED_TOOLS } from '@/llm/chat/tools';
import { readPage } from '@/server/chat/read';
import type { MockDataSource } from '@/server/datasource/mock';
import { collect, mockWith, of, textOf, type Seen } from './helpers';

type G = { __ccDataSource?: unknown };
let ds: MockDataSource;
let seen: Seen;

beforeEach(() => {
  seen = { calls: 0 };
  ds = mockWith({ seen, runner: { planAnswer: 'run' } });
  (globalThis as G).__ccDataSource = ds;
});
afterEach(() => {
  delete (globalThis as G).__ccDataSource;
  ds.dispose();
});

const ask = (text: string, key: string, label: string) => collect(ds.chat({ body: { text, context: [{ type: 'vdp', id: key, label, via: 'auto' }] }, signal: new AbortController().signal } as never));

describe('the Assistant knows the open VDP', () => {
  it('vdp_detail: one VDP in full, every open candidate, within the read budget', async () => {
    const cov = await ds.getVdpCoverage({} as never);
    const key = cov.vdps[0]!.vdpSlug;
    const r = await readPage(ds, 'vdp_detail', { key }, { now: ds.now() });
    const d = r.data as { href: string; vdp: { useCases: Array<{ title: string; missing?: string[] }> }; steps: Array<{ n: number; kind: string }>; assetsToAdd: Array<{ status: string; addIt: { itemKey?: string; waits?: string } }> };
    expect(JSON.stringify(d).length).toBeLessThanOrEqual(14_000);
    expect(d.href).toBe(vdpHrefFor(key));
    expect(d.vdp.useCases.map((u) => u.title)).toEqual(['Unified customer profile', 'Service agent deflection']);
    expect(d.steps.map((s) => s.n)).toEqual(d.steps.map((_, i) => i + 1));
    expect(d.assetsToAdd.map((c) => c.status).sort()).toEqual(['suggested', 'unsure']);
    // D-63: an asset to add is an item to push (no copy text), or says what it waits for
    expect(d.assetsToAdd.find((c) => c.status === 'suggested')!.addIt.itemKey).toMatch(/^asset:/);
    expect(d.assetsToAdd.find((c) => c.status === 'unsure')!.addIt).toEqual({ waits: 'confirm it first' });
    expect(r.summary).toMatch(/2 use cases · 0 assets in VDP · 2 to add/);
    await expect(readPage(ds, 'vdp_detail', { key: 'no-such-vdp' }, { now: ds.now() })).rejects.toThrow(/not found|VDP/i);
  });

  it('"what use cases and assets does this have?" is answered from the open VDP, with links and the steps in order', async () => {
    const cov = await ds.getVdpCoverage({} as never);
    const v = cov.vdps[0]!;
    const evs = await ask('What use cases and assets does this VDP have?', v.vdpSlug, v.companyName);
    expect(seen.prompt).toContain(`- vdp ${v.vdpSlug}: ${v.companyName} (looking at)`);
    const start = of(evs, 'tool-start').find((e) => e.name === 'vdp.read');
    expect(start).toBeTruthy();
    expect(of(evs, 'tool-result').find((e) => e.id === start!.id)).toMatchObject({ ok: true });
    const text = textOf(evs);
    expect(text).toMatch(/Use cases \(2\):.*Service agent deflection \(missing Persona, Execution phase, Target date\)/);
    expect(text).toMatch(/Assets in VDP:\*\* none yet/);
    expect(text).toMatch(/Assets to add \(2\)/);
    expect(text).toContain('https://docs.google.com/presentation/d/PLACEHOLDER0DECK000000000001/edit');
    expect(text).toMatch(/Steps, in order:/);
  });

  it('"go back and find everything" starts Find assets for the open VDP and links its details; nothing is written to VDP', async () => {
    expect(CHAT_ALLOWED_TOOLS).toEqual(expect.arrayContaining(['mcp__chat__plan', 'mcp__chat__run']));
    const cov = await ds.getVdpCoverage({} as never);
    const key = cov.unlinked.find((g) => g.code === 'company_not_in_vdp')!.accountId!;
    const evs = await ask('Go back and find everything for this one: decks, demos, recordings', `account:${key}`, 'Placeholder account');
    // research-class: the plan card first (waiting, then Run), with the governor's estimate
    const plans = of(evs, 'plan').map((e) => e.plan);
    expect(plans.map((p) => p.status)).toEqual(['waiting', 'run']);
    expect(plans[0]!.steps[0]).toMatchObject({ tool: 'run', run: 'vdp_find_assets' });
    expect(plans[0]!.estimate.p90).toBeGreaterThan(0);
    const start = of(evs, 'tool-start').find((e) => e.name === 'vdp.search');
    expect(start).toBeTruthy();
    expect(of(evs, 'tool-result').find((e) => e.id === start!.id)).toMatchObject({ ok: true });
    expect(of(evs, 'resource').map((e) => e.resource?.href)).toContain(vdpHrefFor(`account:${key}`));
    expect(textOf(evs)).toMatch(/looking back through Drive, Slack, Gmail and Calendar.*Nothing is written to VDP/);
    const d = await ds.getVdpDetail({ query: { key: `account:${key}` } } as never);
    expect(d.backfill.last?.status).toMatch(/queued|running|done/);
  });
});
