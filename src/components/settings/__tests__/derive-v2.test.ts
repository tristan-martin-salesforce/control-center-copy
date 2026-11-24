import { describe, expect, it } from 'vitest';
import { DisplaySettings, SETTINGS_SECTION_SCHEMAS, type PolicyRule, type RankRow } from '@/contract';
import { asSectionId, compareRanks, daysLabel, groupOf, hoursPerDay, matchSections, normaliseWatchTarget, policyChanges, scoreBreakdown, SECTION_GROUPS, SECTIONS } from '../derive';

const w = { customer_facing: 3, meeting_proximity: 3, due_urgency: 2.5, manager_ask: 2, deal_value: 1.5, lead_time: 2, age: 0.5, effort_fit: 1 };
const rule: PolicyRule = { id: 'r_customer', text: 'Customer-facing beats internal', enabled: true, when: { customerFacing: true }, boost: 1.5 };
const row = (id: string, rank: number, moved = 0, score = 10 - rank): RankRow => ({ workItemId: id, title: id.toUpperCase(), rank, score, moved, topReason: null });

describe('settings v2: nav', () => {
  it('has five sections plus a folded Advanced, and falls back to Me ▸ Profile & hours', () => {
    // 01-ui-audit R8 (2026-11-20): Me · Sources · Sending · Budgets · Data, then Advanced (policy, thresholds, closing)
    expect(SECTION_GROUPS.map((g) => g.label)).toEqual(['Me', 'Sources', 'Sending', 'Budgets', 'Data', 'Advanced']);
    expect(SECTION_GROUPS.filter((g) => g.collapsed).map((g) => g.id)).toEqual(['advanced']);
    expect(SECTIONS.map((s) => s.id)).toEqual(['profile', 'role', 'display', 'time', 'connectors', 'watches', 'scanning', 'sending', 'agent', 'feedback', 'budgets', 'data', 'about', 'policy', 'thresholds', 'closing']);
    expect(matchSections('@channel')).toEqual(['scanning']);
    expect(matchSections('get up to speed')).toEqual(['scanning']);
    expect(asSectionId('budgets')).toBe('budgets');
    expect(asSectionId('nope')).toBe('profile');
    expect(asSectionId(null)).toBe('profile');
  });

  it('keeps every old ?section= link landing where it did, inside its new section', () => {
    const OLD_TO_NEW: Record<string, string> = {
      profile: 'me', role: 'me', display: 'me', time: 'me',
      connectors: 'sources', watches: 'sources', scanning: 'sources',
      agent: 'sending', sending: 'sending', feedback: 'sending',
      budgets: 'budgets', about: 'data',
      policy: 'advanced', thresholds: 'advanced', closing: 'advanced',
    };
    for (const [old, group] of Object.entries(OLD_TO_NEW)) {
      expect(asSectionId(old)).toBe(old);
      expect(groupOf(asSectionId(old)).id).toBe(group);
    }
  });

  it('opens a section by its own id on its first page', () => {
    expect(asSectionId('me')).toBe('profile');
    expect(asSectionId('sources')).toBe('connectors');
    expect(asSectionId('sending')).toBe('sending');
    expect(asSectionId('data')).toBe('data');
    expect(asSectionId('advanced')).toBe('policy');
  });

  it('finds a setting by label, keyword or current value', () => {
    expect(matchSections('dry run')).toEqual(['sending']);
    expect(matchSections('theme')).toEqual(['display']);
    expect(matchSections('denver', { profile: 'SE (IC) · America/Denver' })).toEqual(['profile']);
    expect(matchSections('zzz')).toEqual([]);
    expect(matchSections('retention')).toEqual(['data']);
    expect(matchSections('backups')).toEqual(['data']);
    expect(matchSections('modified')).toEqual(['about']);
    expect(matchSections('autopilot')).toEqual(['sending']);
  });
});

describe('settings v2: policy', () => {
  it('lists what a draft changes in plain words', () => {
    const draft = { weights: { ...w, due_urgency: 3.5 }, rules: [{ ...rule, enabled: false }, { ...rule, id: 'r_new', text: 'Globex first' }] };
    expect(policyChanges({ weights: w, rules: [rule] }, draft)).toEqual(['Due urgency 2.5 → 3.5', '“Customer-facing beats internal” off', 'new rule “Globex first”']);
    expect(policyChanges({ weights: w, rules: [rule] }, { weights: w, rules: [] })).toEqual(['removed “Customer-facing beats internal”']);
  });

  it('compares before/after: was #N, who enters and who drops out of the top 5', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => row(id, i + 1));
    const after = [row('a', 1), row('c', 2, 1), row('f', 3, 3), row('b', 4, -2), row('d', 5, -1), row('e', 6, -1), row('g', 7)];
    const c = compareRanks(before, after);
    expect(c.after.find((r) => r.id === 'f')!.was).toBe(6);
    expect(c.enters.map((r) => r.id)).toEqual(['f']);
    expect(c.leaves.map((r) => [r.id, r.to])).toEqual([['e', 6]]);
    expect(c.movedTop5).toBe(4);
  });

  it('breaks a score down and follows the draft: weights scale, rules use their boost', () => {
    const reasons = [
      { key: 'customer_facing', label: 'Customer-facing', contribution: 3 },
      { key: 'rule:r_customer', label: 'Rule: Customer-facing beats internal', contribution: 1.5 },
    ];
    const saved = { weights: w, rules: [rule] };
    const draft = { weights: { ...w, customer_facing: 6 }, rules: [{ ...rule, boost: 2 }] };
    const bd = scoreBreakdown(reasons, 5, saved, draft);
    expect(bd.lines.map((l) => [l.key, l.now, l.after, l.changed])).toEqual([
      ['customer_facing', 3, 6, true],
      ['rule:r_customer', 1.5, 2, true],
      ['other', 0.5, 0.5, false],
    ]);
    expect(bd.afterTotal).toBe(8.5);
  });

  it('gives a changed weight outside the top reasons its own line from the real after-score', () => {
    const reasons = [{ key: 'customer_facing', label: 'Customer-facing', contribution: 3 }];
    const saved = { weights: w, rules: [] };
    const draft = { weights: { ...w, effort_fit: 6 }, rules: [] };
    // effort fit signal 1.0: 1 → 6 adds 5; the rest (1.0 other + 1.0 effort fit) was "other signals"
    const bd = scoreBreakdown(reasons, 5, saved, draft, 10);
    expect(bd.lines.map((l) => [l.key, l.now, l.after])).toEqual([
      ['customer_facing', 3, 3],
      ['effort_fit', 1, 6],
      ['other', 1, 1],
    ]);
    expect(bd.afterTotal).toBe(10);
  });
});

describe('settings v2: small helpers', () => {
  it('normalises a typed watch', () => {
    expect(normaliseWatchTarget(' team-updates ')).toEqual({ targetKind: 'channel', target: '#team-updates', label: '#team-updates' });
    expect(normaliseWatchTarget('@dana')).toEqual({ targetKind: 'person', target: 'dana', label: '@dana' });
    expect(normaliseWatchTarget('Flex Credits')).toEqual({ targetKind: 'search', target: 'Flex Credits', label: 'Flex Credits' });
    expect(normaliseWatchTarget('#')).toBeNull();
  });

  it('describes hours and days', () => {
    expect(hoursPerDay('07:30', '17:30')).toBe('10h a day');
    expect(hoursPerDay('09:00', '17:45')).toBe('8h 45m a day');
    expect(hoursPerDay('18:00', '07:00')).toBeNull();
    expect(daysLabel([5, 1, 2, 3, 4])).toBe('Mon–Fri');
    expect(daysLabel([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(daysLabel([])).toBe('No days');
  });
});

describe('settings v2: display contract (additive)', () => {
  it('reads older rows (no scheme or text size, the v1 brand ramp) with v2 defaults', () => {
    const old = DisplaySettings.parse({ version: 3, density: 'compact', theme: 'cosmos', shortcutsEnabled: true });
    expect(old).toMatchObject({ theme: 'cosmos', scheme: 'dark', textSize: 16 });
  });

  it('patches name only what changes (no defaults injected) and rejects other sizes', () => {
    expect(SETTINGS_SECTION_SCHEMAS.display.parse({ textSize: 18 })).toEqual({ textSize: 18 });
    expect(SETTINGS_SECTION_SCHEMAS.display.safeParse({ textSize: 17 }).success).toBe(false);
    expect(SETTINGS_SECTION_SCHEMAS.display.safeParse({ scheme: 'system' }).success).toBe(true);
  });
});

describe('settings v2: Scanning (SCAN-SET)', () => {
  it('the contract defaults, the patch schema and the nav summary', async () => {
    const { DEFAULT_SCANNING_SETTINGS, ScanningSettings } = await import('@/contract');
    const { scanningSummary } = await import('../ScanningSection');
    expect(ScanningSettings.parse({ version: 1 })).toEqual(DEFAULT_SCANNING_SETTINGS);
    expect(DEFAULT_SCANNING_SETTINGS).toMatchObject({ channelAsks: 'ask', meetingCatchUps: false, oppTeamCatchUps: false, mappingQuestions: 'mine' });
    expect(SETTINGS_SECTION_SCHEMAS.scanning.parse({ channelAsks: 'ignore' })).toEqual({ channelAsks: 'ignore' });
    expect(SETTINGS_SECTION_SCHEMAS.scanning.safeParse({ channelAsks: 'sometimes' }).success).toBe(false);
    expect(scanningSummary(undefined)).toBe('Group asks: ask me · catch-ups off');
    expect(scanningSummary({ ...DEFAULT_SCANNING_SETTINGS, channelAsks: 'mine', oppTeamCatchUps: true })).toBe('Group asks: treat as mine · catch-ups on');
  });
});
