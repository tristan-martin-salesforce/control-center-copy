/**
 * P2 pure logic: evidence grouping, actor labels, deliverable judgment, stable ordering, minutes, and
 * profile-timezone wall clock (placeholder seed only).
 */
import { describe, expect, it } from 'vitest';
import type { AuditEntry, DeliverableInfo, Evidence } from '@/contract';
import { actorLabel, diffLines, groupByState, groupEvidence, judgmentWord, latestUndoable, mergePeople, parseMinutes, fmtMin, stableOrder, stripCcTag } from '@/components/detail/lib/derive';
import { dropProposal, optimisticAction } from '@/components/detail/lib/mutations';
import { fmtWhen, fromLocalInput, toLocalInput, wallParts, whenPresets } from '@/components/detail/lib/tz';

const ev = (id: string, role: Evidence['role'], at: string): Evidence => ({
  id,
  workItemId: 'w_1',
  role,
  source: { kind: 'slack', label: '#acme-ext' },
  at,
  summary: id,
  snippet: null,
  author: null,
  isNew: false,
  confidence: null,
});

describe('evidence', () => {
  it('groups by role in the fixed order, newest first, dropping empty roles', () => {
    const groups = groupEvidence([
      ev('c1', 'context', '2026-11-05T10:00:00Z'),
      ev('o1', 'origin', '2026-11-04T09:00:00Z'),
      ev('x1', 'contradiction', '2026-11-05T11:00:00Z'),
      ev('c2', 'context', '2026-11-05T12:00:00Z'),
    ]);
    expect(groups.map((g) => g.role)).toEqual(['origin', 'context', 'contradiction']);
    expect(groups[1]!.items.map((e) => e.id)).toEqual(['c2', 'c1']);
  });
});

describe('history', () => {
  it('labels actors as you · chat · engine · scanner', () => {
    expect(['user', 'chat', 'engine', 'connector', 'scenario'].map((a) => actorLabel(a as AuditEntry['actor']))).toEqual(['You', 'Chat', 'Engine', 'Scanner', 'Scanner']);
  });
  it('finds the latest undoable loop-back for the inline Undo', () => {
    const base = { actor: 'engine' as const, summary: 's', entity: { type: 'work_item' as const, id: 'w', label: 'w' }, related: [], changes: [], undoOf: null };
    const entries: AuditEntry[] = [
      { ...base, id: 'a1', at: '2026-11-05T09:00:00Z', action: 'item.loop_back', undoable: true, undoneAt: '2026-11-05T09:01:00Z' },
      { ...base, id: 'a2', at: '2026-11-05T10:00:00Z', action: 'item.loop_back', undoable: true, undoneAt: null },
      { ...base, id: 'a3', at: '2026-11-05T11:00:00Z', action: 'item.edit', undoable: true, undoneAt: null },
    ];
    expect(latestUndoable(entries, ['item.loop_back', 'item.reopen'])?.id).toBe('a2');
  });
});

describe('deliverable judgment (R-UI-15)', () => {
  const d = (j: DeliverableInfo['judgment'], changed = true): DeliverableInfo => ({ fileName: 'Deck', mimeKind: 'slides', lastEditedAt: null, lastEditedBy: null, changedSinceCreated: changed, diffSummary: null, judgment: j });
  it('maps verdicts to yes · partial · no · unknown', () => {
    expect(judgmentWord(d({ verdict: 'complete', summary: '', requested: 3, made: 3 })).word).toBe('Yes');
    expect(judgmentWord(d({ verdict: 'partial', summary: '', requested: 3, made: 2 })).word).toBe('Partial');
    expect(judgmentWord(d({ verdict: 'in_progress', summary: '', requested: 3, made: 1 })).word).toBe('Partial');
    expect(judgmentWord(d({ verdict: 'in_progress', summary: '', requested: 1, made: 0 })).word).toBe('Unknown');
    expect(judgmentWord(d({ verdict: 'regressed', summary: '', requested: 3, made: 1 })).word).toBe('No');
    expect(judgmentWord(d(null)).word).toBe('Unknown');
  });
  it('splits diff summaries into signed lines', () => {
    expect(diffLines('+2 slides · −1 slide · pricing changed')).toEqual([
      { sign: '+', text: '2 slides' },
      { sign: '-', text: '1 slide' },
      { sign: '~', text: 'pricing changed' },
    ]);
    expect(diffLines(null)).toEqual([]);
  });
});

describe('lists', () => {
  it('keeps known rows in place and appends new ones (nothing moves under the cursor)', () => {
    const a = stableOrder([], [{ id: 'x' }, { id: 'y' }]);
    expect(a.order).toEqual(['x', 'y']);
    expect(a.added).toEqual([]);
    const b = stableOrder(a.order, [{ id: 'z' }, { id: 'y' }, { id: 'x' }]);
    expect(b.order).toEqual(['x', 'y', 'z']);
    expect(b.added).toEqual(['z']);
  });
  it('groups child tasks by state with done last', () => {
    const items = [{ state: 'done' }, { state: 'open' }, { state: 'waiting_on_me' }].map((x, i) => ({ id: `w${i}`, ...x })) as never[];
    expect(groupByState(items).map((g) => g.id)).toEqual(['needs_you', 'open', 'done']);
  });
  it('merges people by id, first role wins', () => {
    const p = mergePeople([{ id: 'p1', name: 'Dana', role: 'Director' }], [{ id: 'p1', name: 'Dana', role: 'AE', email: 'd@example.com' }, { id: 'p2', name: 'Raj' }]);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ role: 'Director', email: 'd@example.com' });
  });
});

describe('minutes and tags', () => {
  it('parses and formats effort', () => {
    expect(parseMinutes('45')).toBe(45);
    expect(parseMinutes('45m')).toBe(45);
    expect(parseMinutes('1h30')).toBe(90);
    expect(parseMinutes('1.5h')).toBe(90);
    expect(parseMinutes('soon')).toBeNull();
    expect(fmtMin(100)).toBe('1h40m');
    expect(fmtMin(0)).toBe('—');
  });
  it('strips the [cc:<id>] routing tag from previews', () => {
    expect(stripCcTag('Build the org [cc:w_1]')).toBe('Build the org');
  });
});

describe('profile-timezone wall clock', () => {
  const tz = 'America/Denver';
  it('round-trips datetime-local values in the profile zone, across DST', () => {
    // (01:00–02:00 on the fall-back day is ambiguous wall time; the first occurrence wins.)
    for (const iso of ['2026-11-05T20:30:00.000Z', '2026-07-01T15:00:00.000Z', '2026-11-01T10:00:00.000Z', '2026-03-08T10:00:00.000Z']) {
      expect(fromLocalInput(toLocalInput(iso, tz), tz)).toBe(iso);
    }
    expect(toLocalInput('2026-11-05T20:30:00.000Z', tz)).toBe('2026-11-05T13:30');
  });
  it('formats relative days in the zone', () => {
    const now = '2026-11-05T15:00:00.000Z'; // 08:00 MT
    expect(fmtWhen('2026-11-05T20:30:00.000Z', now, tz, { today: true })).toBe('Today 13:30');
    expect(fmtWhen('2026-11-06T16:00:00.000Z', now, tz)).toBe('Tomorrow 09:00');
  });
  it('offers future-only snooze presets at 09:00 local', () => {
    const now = '2026-11-05T15:00:00.000Z';
    const p = whenPresets(now, tz);
    expect(p.every((x) => Date.parse(x.at) > Date.parse(now))).toBe(true);
    const tomorrow = p.find((x) => x.id === 'tomorrow')!;
    expect(wallParts(tomorrow.at, tz)).toMatchObject({ d: 6, hh: 9, mm: 0 });
  });
});

describe('optimistic transforms', () => {
  it('applies what the server will do for done, hand-off, snooze and reopen', () => {
    const e = { id: 'w', version: 1, state: 'open', involvement: 'owner', owner: { id: 'me', name: 'Me' } };
    const now = '2026-11-05T15:00:00.000Z';
    expect(optimisticAction(e, 'done', { ifVersion: 1 }, now)).toMatchObject({ state: 'done', resolution: 'done_by_me' });
    expect(optimisticAction(e, 'resolve', { ifVersion: 1, resolution: 'handed_off', detail: { personName: 'Dana' } }, now)).toMatchObject({ state: 'done', resolution: 'handed_off', involvement: 'watcher', owner: { name: 'Dana' } });
    expect(optimisticAction(e, 'snooze', { ifVersion: 1, until: now }, now)).toMatchObject({ state: 'snoozed', snoozedUntil: now });
    expect(optimisticAction({ ...e, state: 'done' }, 'reopen', { ifVersion: 1 }, now)).toMatchObject({ state: 'reopened', resolution: null });
  });
  it('drops a resolved proposal from every cached payload, keeping identity when absent', () => {
    const data = { item: { id: 'w' }, proposals: [{ id: 'p1' }, { id: 'p2' }], cards: [{ proposals: [{ id: 'p1' }] }] };
    const next = dropProposal(data, 'p1');
    expect(next.proposals.map((p) => p.id)).toEqual(['p2']);
    expect(next.cards[0]!.proposals).toEqual([]);
    expect(dropProposal(data, 'nope')).toBe(data);
  });
});
