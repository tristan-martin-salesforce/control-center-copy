/**
 * D-55, found by the release crawl: a source or feature the AE hasn't activated has no daily surface. With VDP broken
 * (the placeholder seed's VDP needs re-auth), an AE sees no "Re-auth VDP" chore on Today, no VDP alert in Home's
 * footer or Today's Health line, no item marked stale because of VDP, and no missed opps in Triage. An SE keeps all
 * of them. Placeholder seed only.
 *
 * 29-persona-qa decision 2, the Specialist AE's mock world (src/mock/persona-seed.ts): loaded as the mock's seed, Home,
 * Today and Time read an AE's week (the forecast call, the pipeline review, Org62 discovery, forecast notes, Sales
 * Events without a task type), not the SE's (demos, SE stand-ups, a VDP to update). Folded here, not a new file, to
 * keep ENG-5's fan-out ratchet (tests/hygiene/engine-fanout.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';
import { EXAMPLE_SEED_PATH, loadSeed, parseSeed } from '@/server/datasource/mock/seed-loader';
import { aeSeedOverlay, personaSeed, writePersonaSeed } from '@/mock/persona-seed';

let ds: MockDataSource;
beforeEach(() => {
  ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed' });
});
afterEach(() => ds.dispose());

async function asPersona(id: 'se' | 'ae') {
  const s = await ds.getSettings({} as never);
  if (s.persona.id !== id) await ds.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s.persona.version, value: { id } } } as never);
}

async function surfaces() {
  const today = await ds.getToday({} as never);
  const home = await ds.getHome({ query: { wide: false } } as never);
  const items = await ds.listItems({ query: { tab: 'all_open' } } as never);
  const triage = await ds.getTriage({} as never);
  const json = JSON.stringify(today);
  return {
    reauthVdpChore: /Re-auth VDP/.test(json),
    footerVdp: home.footer.alerts.some((a) => /VDP/.test(a.label)),
    // the mock's connector ids are the sources ("vdp")
    staleFromVdp: items.items.some((w) => w.stale?.connectorId === 'vdp'),
    missedOpps: triage.groups.some((g) => g.group === 'missed_opps' && g.items.length > 0),
  };
}

describe('an AE (VDP and missed opps not activated)', () => {
  it('the SE baseline: the seed has VDP broken and missed opps, and an SE sees all of them', async () => {
    await asPersona('se');
    expect(await surfaces()).toEqual({ reauthVdpChore: true, footerVdp: true, staleFromVdp: true, missedOpps: true });
  });

  it('an AE sees none of them', async () => {
    await asPersona('ae');
    expect(await surfaces()).toEqual({ reauthVdpChore: false, footerVdp: false, staleFromVdp: false, missedOpps: false });
  });

  it('activating VDP and missed opps brings them back', async () => {
    await asPersona('ae');
    const s = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s.persona.version, value: { features: { vdp: true, missedOpps: true } } } } as never);
    expect(await surfaces()).toEqual({ reauthVdpChore: true, footerVdp: true, staleFromVdp: true, missedOpps: true });
  });
});

const SE_ONLY = /\bdemo\b|SE team|\bVDP\b|task type/i;

let own: MockDataSource | null = null;
afterEach(() => {
  own?.dispose();
  own = null;
});

async function pages(seed: ReturnType<typeof personaSeed>) {
  const ds = (own = createMockDataSource({ seed, autoplay: false, clockMode: 'seed' }));
  const settings = await ds.getSettings({} as never);
  const home = await ds.getHome({ query: { wide: true } } as never);
  const today = await ds.getToday({} as never);
  const log = await ds.getActivityLog({ query: {} } as never);
  return { persona: settings.persona.id, home: JSON.stringify(home), today: JSON.stringify(today), log };
}

describe('the Specialist AE seed overlay', () => {
  it('is the AE persona with its starter policy, and still a valid seed', () => {
    const base = loadSeed({ path: EXAMPLE_SEED_PATH }).seed;
    const ae = aeSeedOverlay(base);
    expect(ae.settings.persona.id).toBe('ae');
    expect(ae.settings.policy.version).toBe(base.settings.policy.version + 1);
    expect(ae.policyVersions.at(-1)?.version).toBe(ae.settings.policy.version);
    expect(() => parseSeed(ae)).not.toThrow();
    // ids and dates stay: every link and the scenario still resolve
    expect(ae.workItems.map((w) => w.id)).toEqual(base.workItems.map((w) => w.id));
    expect(ae.calendar.events.map((e) => [e.id, e.start])).toEqual(base.calendar.events.map((e) => [e.id, e.start]));
    // the base is untouched
    expect(base.settings.persona.id).toBe('se');
  });

  it('Home, Today and Time as the AE read an AE’s week, not the SE’s', async () => {
    const p = await pages(personaSeed('ae'));
    expect(p.persona).toBe('ae');
    expect(p.today).toContain('Specialist AE forecast call');
    expect(p.today).toContain('Pipeline review with my RVP');
    expect(p.home + p.today).toContain('forecast notes');
    expect(p.home + p.today).toContain('Org62 discovery');
    for (const t of ['SE team stand-up', 'ACME Phase 2 demo', 'demo-org build', 'Update the VDP']) {
      expect(p.home).not.toContain(t);
      expect(p.today).not.toContain(t);
    }
    // Time: Sales Events take no task type, and no row reads as the SE's
    expect(p.log.entries.length).toBeGreaterThan(0);
    expect(p.log.entries.every((r) => r.taskType === null)).toBe(true);
    expect(p.log.entries.filter((r) => /SE team|\bdemo\b/i.test(r.description ?? '')).map((r) => r.id)).toEqual([]);
  });

  it('the SE’s seed is the example as it was', async () => {
    const p = await pages(personaSeed('se'));
    expect(p.persona).toBe('se');
    expect(p.today).toContain('SE team stand-up');
    expect(p.today).not.toContain('Specialist AE forecast call');
  });

  it('writes a CC_SEED_PATH file the loader reads as the AE world', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-ae-seed-'));
    try {
      const file = writePersonaSeed('ae', path.join(dir, 'seed.ae.json'));
      expect(existsSync(file)).toBe(true);
      const loaded = loadSeed({ path: file, rebase: false }).seed;
      expect(loaded.settings.persona.id).toBe('ae');
      expect(loaded.meta.asOf).toBe(JSON.parse(readFileSync(EXAMPLE_SEED_PATH, 'utf8')).meta.asOf);
      expect(JSON.stringify(loaded.calendar.events.map((e) => e.title))).not.toMatch(SE_ONLY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
