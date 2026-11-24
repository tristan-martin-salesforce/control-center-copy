// @vitest-environment jsdom
/**
 * 24-visual-qa (seen on the Getting started DC path): a row you just claimed on Missed opportunities showed two
 * Undo buttons side by side (the row's verb and a secondary). One Undo per row; the secondary Undo only when the
 * verb is Open task (a claim that became a task).
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MissedOpp } from '@/contract';
import { $$, cleanup, render } from '@/components/composer/__tests__/dom';
import { VerdictSection, type RowCtx } from '@/components/deals/MissedView.rows';

const base: MissedOpp = {
  id: 'mo_1',
  verdict: 'claim',
  oppId: 'opp_1',
  oppName: 'Globex · Renewal FY27',
  accountName: 'Globex',
  amount: 400000,
  stage: 'Proposal',
  closeDate: '2027-01-15',
  evidence: ['Data 360 product line'],
  otherDcs: [],
  status: 'claimed',
  dismissReason: null,
  claimedWorkItemId: null,
  dcRequestId: 'dcr_1',
  foundAt: '2026-11-05T09:00:00.000Z',
} as MissedOpp;

const noop = () => {};
const ctx: RowCtx = {
  today: '2026-11-21',
  selected: null,
  firstId: null,
  openId: null,
  picked: new Set(),
  expanded: new Set(),
  newIds: new Set(),
  dismissOpenId: null,
  canUndo: () => true,
  onSelect: noop,
  onPick: noop,
  onClaim: noop,
  onDismiss: noop,
  onUndo: noop,
  onOpenTask: noop,
  onToggle: noop,
  setDismissOpenId: noop,
};

const undos = () => $$('button').filter((b) => b.textContent?.trim() === 'Undo');

afterEach(async () => {
  await cleanup();
});

describe('Missed opportunities: one Undo per claimed row', () => {
  it('a claimed DC request: Undo once', async () => {
    await render(h(VerdictSection, { verdict: 'claim', rows: [base], c: ctx, onClaimMany: noop, onDismissMany: noop, onPickAll: noop, batchDismissOpen: null, setBatchDismissOpen: noop }));
    expect(undos()).toHaveLength(1);
  });

  it('a claim that became a task: Open task, and Undo beside it', async () => {
    await render(h(VerdictSection, { verdict: 'claim', rows: [{ ...base, claimedWorkItemId: 'w_1' }], c: ctx, onClaimMany: noop, onDismissMany: noop, onPickAll: noop, batchDismissOpen: null, setBatchDismissOpen: noop }));
    expect(undos()).toHaveLength(1);
    expect($$('button').some((b) => b.textContent?.includes('Open task'))).toBe(true);
  });
});
