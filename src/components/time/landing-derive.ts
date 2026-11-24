/**
 * D-70: how landings and writes read on Activity (pure, tested in ./landing-derive.test.ts). Color is the state, never
 * the record: in the system (ok), it differs (warn), missing (risk), on its way (staged neutral and dashed, sent as the
 * one in progress), never sent (neutral).
 */
import type { Landing, LandingDestination, LandingState, LandingWrite, UseCaseLanding, WriteState } from '@/contract';
import type { Tone } from '@/ui/tones';

export const DEST_LABEL: Record<LandingDestination, string> = { org62: 'Org62', vdp: 'VDP' };

const MARK: Record<LandingState, string> = { verified: '✓', differs: 'differs', missing: 'missing', staged: 'staged', sent: 'sent', not_sent: '—' };
const TONE: Record<LandingState, Tone> = { verified: 'ok', differs: 'warn', missing: 'risk', staged: 'neutral', sent: 'brand', not_sent: 'neutral' };
const WORDS: Record<LandingState, string> = {
  verified: 'In it, read back and matching',
  differs: 'In it, with other values than the other system',
  missing: 'Not found there after it was sent (or deleted there)',
  staged: 'In a batch or item waiting for your Apply',
  sent: 'Sent: waiting for the next read',
  not_sent: 'Not there, and nothing is on its way',
};

/** "Org62 ✓", "VDP —", "Org62 differs". */
export function landingPill(dest: LandingDestination, l: Pick<Landing, 'state'> | null | undefined): { label: string; tone: Tone; dashed: boolean; title: string } {
  const state = l?.state ?? 'not_sent';
  return { label: `${DEST_LABEL[dest]} ${MARK[state]}`, tone: TONE[state], dashed: state === 'staged', title: `${DEST_LABEL[dest]}: ${WORDS[state]}` };
}

/** "Org62 ✓ · VDP —" */
export function whereLine(x: Pick<UseCaseLanding, 'org62' | 'vdp'>): string {
  return `${landingPill('org62', x.org62).label} · ${landingPill('vdp', x.vdp).label}`;
}

const WRITE_WORDS: Record<WriteState, string> = {
  proposed: 'proposed',
  approved: 'approved: in the next batch',
  dismissed: 'dismissed',
  staged: 'waiting for Apply',
  sent: 'sent',
  verified: 'in Org62',
  failed: 'Apply failed',
  removed: 'taken off before Apply',
  rejected: 'batch rejected',
};
const WRITE_TONE: Record<WriteState, Tone> = { proposed: 'ai', approved: 'neutral', dismissed: 'neutral', staged: 'neutral', sent: 'brand', verified: 'ok', failed: 'risk', removed: 'neutral', rejected: 'neutral' };

/** A write's state, in words and its tone (a VDP write is "in VDP" once verified). */
export function writeState(w: Pick<LandingWrite, 'state' | 'destination'>): { label: string; tone: Tone } {
  const label = w.state === 'verified' ? `in ${DEST_LABEL[w.destination]}` : WRITE_WORDS[w.state];
  return { label, tone: WRITE_TONE[w.state] };
}

/** Use case filters on the Use cases tab. */
export type UcFilter = 'all' | 'both' | 'org62' | 'vdp' | 'neither' | 'differs' | 'ready' | 'questions';
export const UC_FILTERS: Array<{ value: UcFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'both', label: 'In both' },
  { value: 'org62', label: 'Org62 only' },
  { value: 'vdp', label: 'VDP only' },
  { value: 'neither', label: 'In neither' },
  { value: 'differs', label: 'Differ' },
  { value: 'ready', label: 'Ready to log' },
  { value: 'questions', label: 'Need you' },
];

export function ucMatches(x: UseCaseLanding, f: UcFilter): boolean {
  if (f === 'all') return true;
  if (f === 'differs') return x.differences.length > 0;
  if (f === 'ready') return x.ready;
  if (f === 'questions') return !!x.question;
  return x.where === f;
}

/** The use cases grouped by company (accounts first by name), as the tab lists them. */
export function ucGroups(items: readonly UseCaseLanding[], f: UcFilter): Array<{ company: string; items: UseCaseLanding[] }> {
  const by = new Map<string, UseCaseLanding[]>();
  for (const x of items) if (ucMatches(x, f)) by.set(x.companyName || 'No company', [...(by.get(x.companyName || 'No company') ?? []), x]);
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([company, xs]) => ({ company, items: xs }));
}

/** A logging run's writes in one line: "3 creates · 1 update · 1 taken off". */
export function runWritesLine(c: { create: number; update: number; delete: number; removed: number }): string {
  const p = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  return [c.create ? p(c.create, 'create') : null, c.update ? p(c.update, 'update') : null, c.delete ? p(c.delete, 'delete') : null, c.removed ? `${c.removed} taken off` : null].filter(Boolean).join(' · ') || 'No writes';
}
