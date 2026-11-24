/**
 * V2-SHELL pure pieces: stored-prefs migration (and the boot script that mirrors it), route titles,
 * nav matching, panel widths, the renderer registry and the sidebar footer lines.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { Connector, HealthPayload } from '@/contract';
import { FRAME_SHORTCUTS, cheatSheetGroups } from './CheatSheet';
import { personaOf } from '@/personas';
import { isNavActive, NAV_DESTINATIONS, NAV_GROUPS, navDestinationsFor, navGroupsFor, panelWidthFor, type NavGroupDef } from './nav';
import { getDetailRenderer, registerDetailRenderer } from './panel';
import { parseStoredPrefs, TEXT_PX, textSizeFrom } from './prefs';
import { PREFS_BOOT_SCRIPT, PREFS_KEY } from './prefs-boot';
import { brokenLines, spendLine, statusLine } from './Sidebar';
import { pageTitleFor } from './titles';

function runBoot(stored: string | null, search = '', osLight = false) {
  const attrs: Record<string, string> = {};
  const ctx = {
    localStorage: { getItem: (k: string) => (k === PREFS_KEY ? stored : null) },
    document: { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } },
    location: { search },
    window: { matchMedia: (q: string) => ({ matches: osLight && q.includes('light') }) },
    URLSearchParams,
  };
  runInNewContext(PREFS_BOOT_SCRIPT, ctx);
  return attrs;
}

describe('prefs', () => {
  it('defaults to dark, comfortable, md when nothing is stored', () => {
    expect(parseStoredPrefs(null)).toBeNull();
    expect(runBoot(null)).toEqual({ 'data-theme': 'dark', 'data-density': 'comfortable', 'data-text': 'md' });
  });

  it('reads v1 storage without crashing: old defaults give way, explicit choices stay, the brand ramp is dropped', () => {
    const v1Defaults = JSON.stringify({ density: 'compact', brand: 'cosmos', scheme: 'light' });
    expect(parseStoredPrefs(v1Defaults)).toEqual({ scheme: 'dark', density: 'comfortable', textSize: 'md' });
    expect(runBoot(v1Defaults)).toEqual({ 'data-theme': 'dark', 'data-density': 'comfortable', 'data-text': 'md' });
    const v1Explicit = JSON.stringify({ density: 'comfortable', brand: 'lightning', scheme: 'dark' });
    expect(parseStoredPrefs(v1Explicit)).toEqual({ scheme: 'dark', density: 'comfortable', textSize: 'md' });
  });

  it('keeps v2 choices, including light, system, compact and text size', () => {
    const v2 = JSON.stringify({ v: 2, scheme: 'light', density: 'compact', textSize: 'lg' });
    expect(parseStoredPrefs(v2)).toEqual({ scheme: 'light', density: 'compact', textSize: 'lg' });
    expect(runBoot(v2)).toEqual({ 'data-theme': 'light', 'data-density': 'compact', 'data-text': 'lg' });
    expect(parseStoredPrefs(JSON.stringify({ v: 2, scheme: 'system' }))?.scheme).toBe('system');
  });

  it('resolves system through prefers-color-scheme before paint', () => {
    const sys = JSON.stringify({ v: 2, scheme: 'system', density: 'comfortable', textSize: 'md' });
    expect(runBoot(sys, '', true)['data-theme']).toBe('light');
    expect(runBoot(sys, '', false)['data-theme']).toBe('dark');
  });

  it('maps text sizes to and from the server px', () => {
    expect(TEXT_PX).toEqual({ sm: 15, md: 16, lg: 18 });
    expect(textSizeFrom(18)).toBe('lg');
    expect(textSizeFrom('sm')).toBe('sm');
    expect(textSizeFrom(17)).toBeNull();
  });

  it('lets ?theme= override the scheme for one load', () => {
    const v2 = JSON.stringify({ v: 2, scheme: 'dark', density: 'compact', textSize: 'lg' });
    expect(runBoot(v2, '?theme=light')).toEqual({ 'data-theme': 'light', 'data-density': 'compact', 'data-text': 'lg' });
    expect(runBoot(null, '?theme=bogus')['data-theme']).toBe('dark');
  });

  it('survives junk', () => {
    expect(parseStoredPrefs('{not json')).toBeNull();
    expect(parseStoredPrefs('"a string"')).toBeNull();
    expect(parseStoredPrefs(JSON.stringify({ v: 2, scheme: 'purple', density: 7, textSize: 'xl' }))).toEqual({ scheme: 'dark', density: 'comfortable', textSize: 'md' });
    expect(runBoot('{not json')).toEqual({});
  });
});

describe('titles and nav', () => {
  it('maps routes to topbar titles', () => {
    expect(pageTitleFor('/')).toBe('Home');
    expect(pageTitleFor('/today')).toBe('Today');
    expect(pageTitleFor('/work')).toBe('Work');
    expect(pageTitleFor('/work/w_1')).toBe('Work item');
    expect(pageTitleFor('/deals/missed')).toBe('Missed opportunities');
    expect(pageTitleFor('/deals/acc_1')).toBe('Account');
    expect(pageTitleFor('/settings/')).toBe('Settings');
    expect(pageTitleFor('/dev/kit/shell')).toBe('Kit');
    expect(pageTitleFor('/nope')).toBe('Command Center');
  });

  it('has the v2 groups and lights the right item', () => {
    expect(NAV_GROUPS.map((g) => g.items.map((i) => i.label))).toEqual([
      ['Home', 'Today', 'Triage', 'Outbox', 'Assistant'],
      ['Work', 'Deals', 'Briefs', 'Agents', 'Activity', 'Journal'],
    ]);
    const home = NAV_GROUPS[0]!.items[0]!;
    const today = NAV_GROUPS[0]!.items[1]!;
    const work = NAV_GROUPS[1]!.items[0]!;
    expect(isNavActive(home, '/')).toBe(true);
    expect(isNavActive(home, '/today')).toBe(false);
    expect(isNavActive(today, '/today')).toBe(true);
    expect(isNavActive(work, '/work/w_1')).toBe(true);
    expect(isNavActive(work, '/initiatives/i_1')).toBe(true);
    expect(isNavActive(work, '/workshop')).toBe(false);
  });

  it('gives the SE and the AE the same sidebar today (no item belongs to a persona feature yet)', () => {
    const se = personaOf({ persona: { id: 'se' } });
    const ae = personaOf({ persona: { id: 'ae' } });
    expect(navGroupsFor(se)).toEqual(NAV_GROUPS);
    expect(navGroupsFor(ae)).toEqual(NAV_GROUPS);
    expect(navGroupsFor(null)).toEqual(NAV_GROUPS);
    expect(navDestinationsFor(se)).toEqual(NAV_DESTINATIONS);
    expect(navDestinationsFor(ae)).toEqual(NAV_DESTINATIONS);
    expect(cheatSheetGroups(navDestinationsFor(ae))).toEqual(cheatSheetGroups());
  });

  it('drops an item whose persona feature is inactive (and a group it leaves empty), and hides it while loading', () => {
    const groups: NavGroupDef[] = [
      { id: 'main', items: [{ href: '/', label: 'Home', icon: 'home', chord: 'g h' }] },
      { id: 'se-only', label: 'VDP', items: [{ href: '/vdp', label: 'VDPs', icon: 'opportunity', chord: 'g v', feature: 'vdp' }] },
    ];
    const labels = (gs: NavGroupDef[]) => gs.map((g) => g.items.map((i) => i.label));
    expect(labels(navGroupsFor(personaOf({ persona: { id: 'se' } }), groups))).toEqual([['Home'], ['VDPs']]);
    expect(labels(navGroupsFor(personaOf({ persona: { id: 'ae' } }), groups))).toEqual([['Home']]);
    expect(labels(navGroupsFor(personaOf({ persona: { id: 'ae', features: { vdp: true } } }), groups))).toEqual([['Home'], ['VDPs']]);
    expect(labels(navGroupsFor(null, groups))).toEqual([['Home']]);
    const list = groups.flatMap((g) => g.items);
    expect(navDestinationsFor(personaOf({ persona: { id: 'ae' } }), list).map((i) => i.chord)).toEqual(['g h']);
    expect(cheatSheetGroups(navDestinationsFor(personaOf({ persona: { id: 'ae' } }), list)).find((g) => g.id === 'goto')!.items).toEqual([{ keys: 'g h', label: 'Home' }]);
  });

  it('has one chord per destination', () => {
    const chords = NAV_DESTINATIONS.map((n) => n.chord);
    expect(new Set(chords).size).toBe(chords.length);
  });

  it('sizes the panel 520 below a 2,400 px frame and 600 from 2,400', () => {
    expect(panelWidthFor(1440)).toBe(520);
    expect(panelWidthFor(2399)).toBe(520);
    expect(panelWidthFor(2400)).toBe(600);
    expect(panelWidthFor(2560)).toBe(600);
  });

  it('lists the frame keys in the cheat sheet', () => {
    const keys = FRAME_SHORTCUTS.items.map((i) => i.keys);
    expect(keys).toEqual(expect.arrayContaining(['mod+j', 'escape', ']', '[', 'mod+k']));
    const groups = cheatSheetGroups();
    expect(groups[0]!.id).toBe('global');
    expect(groups.some((g) => g.id === 'rail')).toBe(false);
  });
});

describe('detail renderer registry', () => {
  it('registers, replaces and unregisters', () => {
    const a = () => 'a';
    const b = () => 'b';
    const offA = registerDetailRenderer('brief', a);
    expect(getDetailRenderer('brief')).toBe(a);
    const offB = registerDetailRenderer('brief', b);
    offA(); // stale unregister leaves the newer one alone
    expect(getDetailRenderer('brief')).toBe(b);
    offB();
    expect(getDetailRenderer('brief')).toBeUndefined();
  });
});

function conn(id: string, state: Connector['state'], lastSuccessAt: string | null): Connector {
  return {
    id,
    label: id.toUpperCase(),
    source: 'slack',
    state,
    since: lastSuccessAt ?? '2026-11-05T08:00:00.000Z',
    lastSuccessAt,
    cursor: { label: '', at: null },
    backlog: 0,
    itemsToday: 0,
    catchUpPct: state === 'catching_up' ? 60 : null,
    lastError: null,
    impact: null,
    reauth: null,
    affects: [],
  };
}

function health(cs: Connector[], extra: Partial<HealthPayload> = {}): HealthPayload {
  const broken = cs.filter((c) => c.state !== 'ok').map((c) => ({ id: c.id, label: c.label, state: c.state }));
  return {
    connectors: cs,
    summary: { ok: cs.filter((c) => c.state === 'ok').length, total: cs.length, worst: broken[0]?.state ?? 'ok', broken },
    spend: { today: { usd: 0.64, softBudgetUsd: 5, hardCapUsd: 15, pct: 13 }, state: 'ok', last7d: [], byScanner: [], byModel: [] },
    worker: { alive: true, lastHeartbeatAt: null, queueDepth: 0 },
    dryRun: true,
    firstScan: null,
    ...extra,
  } as HealthPayload;
}

describe('sidebar footer lines', () => {
  const now = new Date('2026-11-05T15:22:00.000Z');
  const fresh = new Date(now.getTime() - 40_000).toISOString();

  it('says nothing about health while everything works', () => {
    const h = health([conn('slack', 'ok', fresh), conn('vdp', 'ok', fresh)]);
    expect(brokenLines(h)).toEqual([]);
    expect(statusLine(h, now, 'open')).toMatchObject({ text: '2/2 sources live', sending: 'dry run', tone: 'live' });
    expect(spendLine(h.spend)).toEqual({ text: '$0.64 of $5 today', tone: 'quiet' });
  });

  it('names what is broken, and only that', () => {
    const h = health([conn('slack', 'ok', fresh), conn('vdp', 'auth_needed', fresh), conn('drive', 'degraded', fresh)], { worker: { alive: false, lastHeartbeatAt: null, queueDepth: 0 } });
    expect(brokenLines(h).map((b) => b.text)).toEqual(['Scanner worker stopped', 'VDP needs re-auth']);
  });

  it('lets the pulse speak only when it has news, and makes live send loud', () => {
    const catching = health([conn('slack', 'catching_up', fresh), conn('gmail', 'ok', fresh)], { dryRun: false });
    expect(statusLine(catching, now, 'open')).toMatchObject({ text: 'Catching up · SLACK 60%', sending: 'live send', tone: 'catching' });
    const stale = health([conn('slack', 'ok', new Date(now.getTime() - 15 * 60_000).toISOString())]);
    expect(statusLine(stale, now, 'open')).toMatchObject({ text: 'Last scan 15m', tone: 'stale' });
    expect(statusLine(stale, now, 'closed')).toMatchObject({ text: 'Reconnecting…', tone: 'off' });
    expect(statusLine(undefined, now, 'open').text).toBe('Checking sources…');
  });

  it('escalates spend at the soft alert and the cap', () => {
    const base = health([]).spend;
    expect(spendLine({ ...base, state: 'soft_alert', today: { ...base.today, usd: 4.2 } })).toEqual({ text: '$4.20 of $5 today', tone: 'warn' });
    expect(spendLine({ ...base, state: 'capped', today: { ...base.today, usd: 15 } })).toEqual({ text: 'Spend cap reached · $15', tone: 'risk' });
  });
});
