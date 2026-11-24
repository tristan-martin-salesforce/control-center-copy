/**
 * 2026-11-13 audit C9: nothing the app computes for the screen goes unread. `loggingGap` (approved hours never in Org62)
 * was computed for weeks and drawn nowhere, and the DC count sat in a step title the page never drew. This fails when
 * an exported derive / model function or interface field has no reader outside tests (./unread.ts). An intentional one
 * goes in ALLOWED with why; anything else is either drawn or deleted.
 */
import { describe, expect, it } from 'vitest';

import { findUnread } from './unread';

/**
 * `module:kind:name` → why it is fine unread. Empty since 2026-11-14: the 18 the guard found on its first run were
 * drawn (GuestSummary.answers, the hover card's tally) or deleted (superseded by what the screens draw now).
 */
const ALLOWED: Record<string, string> = {
  // F4 (lanes review R2-4): the quarter card no longer draws the cross-quarter spill (History ▸ Batches' "Landed in"
  // line reads the batch's quarters). path-derive is outside F4's glob: drop these with the spill in a path-derive chunk.
  'src/components/time/path-derive.ts:export:spillLine': 'F4 moved the landed-in line to History ▸ Batches; delete with QuarterTruth.spill',
  'src/components/time/path-derive.ts:field:CanvasSpill.hereH': 'F4 moved the landed-in line to History ▸ Batches; delete with QuarterTruth.spill',
  'src/components/time/path-derive.ts:field:QuarterTruth.spill': 'F4: the card tells no batch; delete in a path-derive chunk',
  // F1 (2026-11-23 lanes review, R2-1): FixLane.tsx / ToLogView.tsx (F6's files) pass today's day; until then lane 1
  // falls back to the latest row's quarter. Drop this entry when they do.
  'src/components/time/fix-derive.ts:field:FixInput.today': 'F6 wires it in FixLane.tsx and ToLogView.tsx',
  // C4 (2026-11-23) took the Needs you count line that read it; C6 draws lane 3 (Sending) from it and drops this entry
};

describe('derive and model fields have readers', () => {
  it('every exported derive/model function and field is read somewhere outside tests', () => {
    const found = findUnread().map((u) => `${u.module}:${u.kind}:${u.name}`);
    const unexpected = found.filter((k) => !(k in ALLOWED));
    expect(unexpected, `computed but never read (draw it, delete it, or allow-list it with why):\n${unexpected.join('\n')}`).toEqual([]);
  });

  it('the allow-list has no stale entries', () => {
    const found = new Set(findUnread().map((u) => `${u.module}:${u.kind}:${u.name}`));
    expect(Object.keys(ALLOWED).filter((k) => !found.has(k))).toEqual([]);
  });
});
