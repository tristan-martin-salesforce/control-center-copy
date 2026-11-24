/**
 * priority@2 properties (hand-rolled, seeded): over random days of work,
 *  - a bigger deal never lowers an item's value or priority;
 *  - a nearer deadline never lowers its urgency or priority;
 *  - a meeting added inside the window moves start-by earlier, never later (for every item).
 * And the rank-level behaviours: admin never in the Top N, likely-done out, the why keeps its two parts.
 */
import { describe, expect, it } from 'vitest';
import { rankWorkV2 } from '@/engines/priority/v2/rank';
import { personaOf } from '@/personas';
import type { PriorityItem } from '@/engines/types';
import type { PriorityInputs } from '@/engines/priority/types';
import { at, inputs, int, item, meeting, pick, rng } from './fixtures';

const SE = personaOf({ persona: { id: 'se' } }).priority;
const H = 3_600_000;
const NOW = Date.parse(at('09:00'));
const DAYS = ['2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11'];

function randomDay(seed: number): PriorityInputs {
  const r = rng(seed);
  const items: PriorityItem[] = [];
  const n = int(r, 3, 12);
  for (let i = 0; i < n; i++) {
    const day = pick(r, DAYS);
    const due = `${day}T${String(int(r, 10, 17)).padStart(2, '0')}:${pick(r, ['00', '30'])}:00.000Z`;
    items.push(
      item(`w${i}`, {
        kind: pick(r, ['task', 'ask', 'commitment', 'follow_up'] as const),
        due: r() < 0.85 ? due : null,
        dueKind: pick(r, ['hard', 'soft', 'inferred', null] as const),
        effort: { youMin: pick(r, [10, 20, 30, 45, 60, 90, 120, 180]), agentMin: pick(r, [0, 0, 30, 60]) },
        importance: pick(r, ['low', 'normal', 'high', 'critical'] as const),
        oppAmount: pick(r, [null, 50_000, 300_000, 800_000, 2_000_000]),
        oppId: 'o',
        stakeholders: [{ id: `p${i}`, name: `Person ${i}`, tier: pick(r, ['customer', 'customer_exec', 'teammate', 'ae'] as const) }],
      }),
    );
  }
  const meetings = Array.from({ length: int(r, 0, 6) }, (_, i) => {
    const day = pick(r, DAYS);
    const h = int(r, 9, 16);
    return meeting(`m${i}`, `${day}T${String(h).padStart(2, '0')}:00:00.000Z`, `${day}T${String(h).padStart(2, '0')}:${pick(r, ['30', '45'])}:00.000Z`);
  });
  return inputs({ items, meetings, horizonMeetings: meetings, priorityConfig: SE });
}

const SEEDS = Array.from({ length: 60 }, (_, i) => 1000 + i * 7);

describe('priority@2 properties', () => {
  it('monotone in deal value: a bigger deal never lowers value or priority', () => {
    for (const seed of SEEDS) {
      const base = randomDay(seed);
      const target = base.items[0]!;
      const before = rankWorkV2(base).scores[target.id]!;
      for (const amount of [100_000, 600_000, 1_500_000, 4_000_000]) {
        if ((target.oppAmount ?? 0) >= amount) continue;
        const after = rankWorkV2({ ...base, items: base.items.map((w) => (w.id === target.id ? { ...w, oppAmount: amount } : w)) }).scores[target.id]!;
        expect(after.v2!.value, `seed ${seed} amount ${amount}`).toBeGreaterThanOrEqual(before.v2!.value);
        expect(after.total, `seed ${seed} amount ${amount}`).toBeGreaterThanOrEqual(before.total);
      }
    }
  });

  it('a nearer deadline never lowers urgency or priority (deadlines ahead)', () => {
    for (const seed of SEEDS) {
      const base = randomDay(seed);
      const target = base.items.find((w) => w.due && Date.parse(w.due) - NOW > 30 * H);
      if (!target) continue;
      const before = rankWorkV2(base).scores[target.id]!;
      for (const hoursEarlier of [4, 12, 24]) {
        const due = new Date(Date.parse(target.due!) - hoursEarlier * H);
        if (due.getTime() <= NOW + H) continue;
        const after = rankWorkV2({ ...base, items: base.items.map((w) => (w.id === target.id ? { ...w, due: due.toISOString() } : w)) }).scores[target.id]!;
        expect(after.v2!.urgency, `seed ${seed} −${hoursEarlier}h`).toBeGreaterThanOrEqual(before.v2!.urgency);
        expect(after.total, `seed ${seed} −${hoursEarlier}h`).toBeGreaterThanOrEqual(before.total - 1e-9);
      }
    }
  });

  it('a meeting added inside the window moves every start-by earlier, never later', () => {
    for (const seed of SEEDS) {
      const base = randomDay(seed);
      const r = rng(seed + 1);
      const before = rankWorkV2(base);
      const day = pick(r, DAYS.slice(0, 3));
      const h = int(r, 9, 16);
      const added = meeting('added', `${day}T${String(h).padStart(2, '0')}:00:00.000Z`, `${day}T${String(h + 1).padStart(2, '0')}:00:00.000Z`);
      const after = rankWorkV2({ ...base, meetings: [...base.meetings, added], horizonMeetings: [...(base.horizonMeetings ?? []), added] });
      for (const w of base.items) {
        const a = before.scores[w.id]?.v2?.startBy;
        const b = after.scores[w.id]?.v2?.startBy;
        if (!a || !b) continue;
        expect(Date.parse(b), `seed ${seed} item ${w.id}`).toBeLessThanOrEqual(Date.parse(a));
      }
    }
  });
});

describe('priority@2 ranking behaviour', () => {
  const day = (over: Partial<PriorityInputs> = {}) => inputs({ priorityConfig: SE, ...over });

  it('engine version and the two-part why', () => {
    const r = rankWorkV2(day({ items: [item('demo', { title: 'Build the ACME demo', due: at('17:00'), oppId: 'o', oppAmount: 2_000_000, stakeholders: [{ id: 'v', name: 'Vera Ruiz', tier: 'customer_exec' }] })] }));
    expect(r.engineVersion).toBe('priority@2');
    const s = r.scores.demo!;
    expect(s.why.matters).toBe('Vera Ruiz (customer exec) · opp $2M');
    expect(s.why.now).toContain('due 17:00');
    expect(s.v2).toMatchObject({ bucket: 'later_today', kindClass: 'customerTask' });
    expect(s.reasons[0]).toMatchObject({ key: 'value.who' });
  });

  it('admin is one batch: never in the Top N, after everything else', () => {
    const items = [
      item('log', { title: "Log this week's time to Org62", due: at('16:00') }),
      item('vdp', { title: 'Add the deck to the ACME VDP', due: at('17:00') }),
      item('a', { due: at('17:00', '2026-11-09') }),
    ];
    const r = rankWorkV2(day({ items }));
    expect(r.top3).toEqual(['a']);
    expect(r.ranked.map((s) => s.workItemId)).toEqual(['a', 'log', 'vdp']);
    expect(r.adminBatch).toMatchObject({ count: 2, promoted: true });
    expect(r.adminBatch!.label).toMatch(/^Admin: 2 items · ~/);
  });

  it('likely-done items wait in Looks done; waiting on others plans a chase', () => {
    const r = rankWorkV2(
      day({
        items: [
          item('ld', { status: 'likely_done', due: at('12:00') }),
          item('w', { status: 'waiting_on_others', createdAt: at('08:00'), stakeholders: [{ id: 'c', name: 'Cara Diaz', tier: 'customer' }] }),
        ],
      }),
    );
    expect(r.ranked).toHaveLength(0);
    expect(r.chases).toEqual([{ workItemId: 'w', title: 'w', at: at('17:00'), label: 'Chase Cara 17:00' }]);
  });

  it('awaiting them lowers urgency (the item stays ranked, with a chase)', () => {
    const w = item('aw', { due: at('17:00'), stakeholders: [{ id: 'c', name: 'Cara', tier: 'customer' }] });
    const me = rankWorkV2(day({ items: [w] })).scores.aw!.v2!.urgency;
    const them = rankWorkV2(day({ items: [{ ...w, awaiting: 'them' }] }));
    expect(them.scores.aw!.v2!.urgency).toBeLessThan(me);
    expect(them.chases).toHaveLength(1);
  });

  it('an owed reply with no date is due by the asker’s tier SLA (working hours)', () => {
    const r = rankWorkV2(day({ items: [item('ask', { kind: 'ask', createdAt: at('08:00'), stakeholders: [{ id: 'x', name: 'Vera', tier: 'customer_exec' }] })] }));
    expect(r.scores.ask!.v2!.needBy).toMatchObject({ source: 'reply_sla', at: at('13:00') });
  });

  it('a size class sets the effort when the item has no estimate', () => {
    const r = rankWorkV2(day({ items: [{ ...item('s', { effort: { youMin: 0, agentMin: 0 }, due: at('17:00', '2026-11-06') }), size: 'l' }] }));
    expect(r.scores.s!.effort.youMin).toBe(180);
  });

  it('overbooked: the capacity says so and Make room proposes the lowest value first', () => {
    const items = [
      item('big', { due: at('17:00'), effort: { youMin: 300, agentMin: 0 }, importance: 'critical', oppId: 'o', oppAmount: 2_000_000 }),
      item('small', { due: at('17:00'), dueKind: 'soft', effort: { youMin: 300, agentMin: 0 }, importance: 'low' }),
    ];
    const r = rankWorkV2(day({ items }));
    expect(r.capacity.fits).toBe(false);
    expect(r.makeRoom!.label).toBe(`Overbooked by ${r.capacity.youMinToday - r.capacity.freeMin} min`);
    expect(r.makeRoom!.rows[0]!.itemId).toBe('small');
  });

  it('a focus block is planned time, not a deadline: the work starts by the block', () => {
    const focus = meeting('f', at('14:00'), at('16:00'), { title: 'Focus: ACME deck', eventType: 'focus_time' });
    const r = rankWorkV2(day({ items: [item('deck', { due: at('17:00', '2026-11-09'), servesEventId: 'f' })], meetings: [focus], horizonMeetings: [focus] }));
    expect(r.scores.deck!.v2!.needBy).toMatchObject({ source: 'due' });
    expect(r.scores.deck!.v2!.startBy).toBe(at('14:00'));
  });
});
