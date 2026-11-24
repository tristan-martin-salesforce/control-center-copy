// @vitest-environment jsdom
/**
 * Drain mode on the Outbox and Triage (02-ui-research P1, P3, P10): which rows each walks, and that every verb is
 * the page's own path. Outbox approve goes through the send flow (preview → confirm → undo window), never straight to
 * dispatch; reject and Triage's verbs record their audit ids, and Undo reverts exactly the open batch.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OutboxItem, TriageItem } from '@/contract';
import { outboxAdapter, reviewableDrafts } from '../../app/outbox/_outbox/OutboxReview';
import { reviewableGuesses, triageAdapter } from '../../app/triage/_triage/TriageReview';

const draft = (id: string, group: OutboxItem['group'], status = 'ready') => ({ group, draft: { id, status } }) as unknown as OutboxItem;
const guess = (id: string, group: string, kind: TriageItem['kind'] = 'work_item') => ({ id, group, kind, title: id, workItem: kind === 'work_item' ? { id } : undefined }) as unknown as TriageItem;

describe('Outbox drain', () => {
  it('walks what waits on you: Approve, then Retry; never sent, scheduled or sending', () => {
    const items = [draft('f1', 'failed'), draft('s1', 'sent'), draft('p1', 'pending_approval'), draft('p2', 'pending_approval', 'sending'), draft('sc', 'scheduled'), draft('p3', 'pending_approval')];
    expect(reviewableDrafts(items).map((i) => i.id)).toEqual(['p1', 'p3', 'f1']);
  });

  it('approve is the send flow; reject keeps its audit id; Undo reverts only that batch', async () => {
    const approveAndWait = vi.fn(async () => 'dry_run' as const);
    const undoPending = vi.fn(() => [] as string[]);
    const reject = vi.fn(async (id: string) => ({ auditId: `a_${id}` }));
    const undoAudit = vi.fn(async () => ({}));
    const refetch = vi.fn();
    const edit = vi.fn();
    const audits = new Map<string, string>();
    const a = outboxAdapter({ send: { approveAndWait, undoPending }, reject, undoAudit, edit, refetch, dryRun: true }, audits);
    const [p1, p2] = reviewableDrafts([draft('p1', 'pending_approval'), draft('p2', 'pending_approval')]);

    await a.approve(p1!);
    expect(approveAndWait).toHaveBeenCalledWith(p1!.draft);
    expect(a.snooze).toBeUndefined(); // no draft snooze in the API: j skips
    await a.dismiss!(p2!);
    expect(reject).toHaveBeenCalledWith('p2');
    expect(audits.get('p2')).toBe('a_p2');
    a.edit!(p2!);
    expect(edit).toHaveBeenCalledWith('p2');

    await a.undo({ verb: 'dismiss', items: [p2!] });
    expect(undoAudit).toHaveBeenCalledWith('a_p2');
    expect(audits.has('p2')).toBe(false);

    await a.undo({ verb: 'approve', items: [p1!] });
    expect(undoPending).toHaveBeenCalledWith(['p1']);
    expect(a.labels?.approve).toBe('Approve (dry run)');
    expect(a.past?.approve).toBe('Rendered');
  });

  it('an approve that already left cannot be undone, and says so', async () => {
    const a = outboxAdapter({ send: { approveAndWait: vi.fn(), undoPending: () => ['p1'] }, reject: vi.fn(), undoAudit: vi.fn(), edit: vi.fn(), refetch: vi.fn(), dryRun: false }, new Map());
    await expect(a.undo({ verb: 'approve', items: reviewableDrafts([draft('p1', 'pending_approval')]) })).rejects.toThrow('1 already went out; the rest are back.');
  });
});

describe('Triage drain', () => {
  it('walks the guesses: asks, takeaways and old asks; not looks done, mappings, missed opps or closed rows', () => {
    const items = [guess('ld', 'looks_done'), guess('a1', 'asks_promises'), guess('m1', 'mappings', 'mapping'), guess('t1', 'meeting_takeaways'), guess('mo', 'missed_opps', 'missed_opp'), guess('sn', 'still_needed'), guess('c1', 'closed_for_you')];
    expect(reviewableGuesses(items).map((i) => i.id)).toEqual(['a1', 't1', 'sn']);
  });

  it('accept, later and not mine are the page’s own calls; Undo reverts the batch by audit id', async () => {
    const accept = vi.fn(async (id: string) => ({ auditId: `acc_${id}` }));
    const dismiss = vi.fn(async (id: string, reason: string) => ({ auditId: `${reason}_${id}` }));
    const undoAudit = vi.fn(async () => ({}));
    const refetch = vi.fn();
    const audits = new Map<string, string>();
    const a = triageAdapter({ accept, dismiss, undoAudit, edit: vi.fn(), refetch }, audits);
    const [g1, g2, g3] = [guess('g1', 'asks_promises'), guess('g2', 'asks_promises'), guess('g3', 'meeting_takeaways')];

    await a.approve(g1!);
    await a.snooze!(g2!);
    await a.dismiss!(g3!);
    expect(accept).toHaveBeenCalledWith('g1');
    expect(dismiss).toHaveBeenCalledWith('g2', 'later');
    expect(dismiss).toHaveBeenCalledWith('g3', 'not_mine');
    expect(refetch).toHaveBeenCalledTimes(3);

    await a.undo({ verb: 'snooze', items: [g2!] });
    expect(undoAudit).toHaveBeenCalledTimes(1);
    expect(undoAudit).toHaveBeenCalledWith('later_g2');
    expect([...audits.keys()].sort()).toEqual(['g1', 'g3']);
    expect(a.labels).toEqual({ approve: 'Accept', snooze: 'Later', dismiss: 'Not mine' });
  });
});
