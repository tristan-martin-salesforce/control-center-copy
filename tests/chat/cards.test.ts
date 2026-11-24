/**
 * The proposal and receipt cards with big lists and partial Applies (A2, A3, 2026-11-13): a 200-line card shows its
 * first lines, opens up in steps and says how many there are; an Apply that landed some changes says "Applied 54 of
 * 55 · 1 failed" and lists each failed line with its reason. Static markup, placeholder names only.
 */
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Proposal, Receipt } from '@/contract';
import { ChatProposalCard } from '@/components/chat/ChatProposalCard';
import { ChatReceiptCard } from '@/components/chat/ChatReceiptCard';
import { appliedHead } from '@/components/chat/card-parts';

// the components compile with the classic JSX runtime here
(globalThis as { React?: typeof React }).React = React;

const at = '2026-11-13T16:00:00.000Z';
const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ field: 'createDcRequest', label: `DC claim · ACCOUNT_${i + 1} · Renewal`, before: null, after: '100% · “SE support”' }));
const proposal = (n: number): Proposal => ({ id: 'p_big', entity: { type: 'chat_thread', id: 't1', label: `${n} changes from chat` }, changes: lines(n), reason: `Claim DCs on these ${n} opportunities?`, source: null, createdAt: at, status: 'pending', actor: 'chat', baseVersion: null, textDiff: null, resolvedAt: null });
const noop = () => undefined;

describe('a card of 200+ lines', () => {
  it('is one card: the first lines, then "Show 50 more", "Show all" and the count', () => {
    const html = renderToStaticMarkup(createElement(ChatProposalCard, { proposal: proposal(220), state: { status: 'pending' }, onApply: noop, onDismiss: noop, onUndo: noop }));
    expect(html).toContain('220 changes');
    expect(html).toContain('data-lines="220"');
    expect(html.match(/DC claim · ACCOUNT_/g)).toHaveLength(5);
    expect(html).toContain('Show 50 more');
    expect(html).toContain('Show all 220');
    expect(html).toContain('5 of 220');
  });
});

describe('a partial Apply', () => {
  const failed = [{ label: 'DC claim · ACCOUNT_55 · Pilot', reason: 'Org62 has no Opportunity "006XX0000NOPE99AAA" that you can see', route: 'createDcRequest' }];
  const receipt: Receipt = {
    id: 'r1',
    at,
    actor: 'chat',
    summary: 'Applied 54 of 55 · 1 failed: Org62 has no Opportunity. Claim DCs on these 55 opportunities?',
    changes: Array.from({ length: 54 }, (_, i) => ({ auditId: `aud_${i}`, entity: { type: 'opportunity', id: `opp_${i}`, label: `ACCOUNT_${i + 1} · Renewal` }, field: 'createDcRequest', label: 'DC claim', before: null, after: '100% · next logging canvas' })),
    staged: false,
    total: 55,
    failed,
  };

  it('the head says how many landed and how many failed', () => {
    expect(appliedHead(54, failed, 55)).toEqual({ text: 'Applied 54 of 55', warn: '1 failed' });
    expect(appliedHead(3, [], 3)).toEqual({ text: 'Applied 3 changes', warn: null });
  });

  it('the applied card lists each failed line with why, under the ones that landed', () => {
    const html = renderToStaticMarkup(createElement(ChatProposalCard, { proposal: { ...proposal(55), status: 'applied' }, state: { status: 'applied', auditId: 'aud_53', receipt }, onApply: noop, onDismiss: noop, onUndo: noop }));
    expect(html).toContain('Applied 54 of 55');
    expect(html).toContain('1 failed');
    expect(html).toContain('data-failed-count="1"');
    expect(html).toContain('Not applied (1): the rest landed');
    expect(html).toContain('DC claim · ACCOUNT_55 · Pilot');
    expect(html).toContain('Org62 has no Opportunity');
  });

  it('the receipt card does too, with Undo all for the change sets that landed', () => {
    const html = renderToStaticMarkup(createElement(ChatReceiptCard, { title: receipt.summary, at, changes: receipt.changes.map((c) => ({ label: c.label!, before: '—', after: String(c.after), auditId: c.auditId, entityLabel: c.entity.label })), onUndo: noop, onUndoAll: noop, failed, total: 55 }));
    expect(html).toContain('Applied 54 of 55');
    expect(html).toContain('Undo all');
    expect(html).toContain('Not applied (1)');
    expect(html).toContain('Show 49 more');
  });
});
