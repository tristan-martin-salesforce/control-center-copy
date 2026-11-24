/**
 * Settings ▸ Time ▸ AEs I cover, one row's coverage (D-103 (a)): what it is (an AE I support, an OOO cover, an SME
 * assist), when it holds, the default DC split it gives, and a one-line note. Saved with the section.
 */
import { COVERAGE_DEFAULT_SHARE, type CoverageKind, type CoveredAe } from '@/contract';
import { Select, TextInput } from './controls';

const KINDS: ReadonlyArray<{ v: CoverageKind; label: string }> = [
  { v: 'ae', label: 'AE I support' },
  { v: 'ooo', label: 'Covering (OOO)' },
  { v: 'sme', label: 'SME assist' },
];
const SHARES = [100, 50, 25] as const;

/** "50% · Covering (OOO) · covering for <TA> · 2026-11-03 to 2026-11-14" (the row's summary line). */
export function coverageWords(a: CoveredAe): string {
  const kind = a.kind ?? 'ae';
  const share = a.creditShare ?? COVERAGE_DEFAULT_SHARE[kind];
  const w = a.window ? (a.window.to ? `${a.window.from} to ${a.window.to}` : `since ${a.window.from}`) : null;
  return [`${share}%`, KINDS.find((k) => k.v === kind)?.label, a.note, w].filter(Boolean).join(' · ');
}

export function CoverageRowFields({ a, i, onChange }: { a: CoveredAe; i: number; onChange: (patch: Partial<CoveredAe>) => void }) {
  const kind = a.kind ?? 'ae';
  const setWindow = (from: string, to: string) => onChange({ window: from ? { from, ...(to ? { to } : {}) } : undefined });
  return (
    <span className="flex flex-wrap items-center gap-2 pt-1" data-testid="t-ae-coverage">
      <Select id={`t-ae-kind-${i}`} aria-label={`What covering ${a.name} is`} value={kind} onChange={(e) => onChange({ kind: e.target.value as CoverageKind, creditShare: undefined })} data-testid="t-ae-kind">
        {KINDS.map((k) => (
          <option key={k.v} value={k.v}>
            {k.label}
          </option>
        ))}
      </Select>
      <Select id={`t-ae-share-${i}`} aria-label={`Default DC split for ${a.name}`} value={String(a.creditShare ?? COVERAGE_DEFAULT_SHARE[kind])} onChange={(e) => onChange({ creditShare: Number(e.target.value) as 100 | 50 | 25 })} data-testid="t-ae-share">
        {SHARES.map((n) => (
          <option key={n} value={n}>
            {`${n}%`}
          </option>
        ))}
      </Select>
      <TextInput id={`t-ae-from-${i}`} type="date" aria-label={`Covering ${a.name} from`} value={a.window?.from ?? ''} onChange={(e) => setWindow(e.target.value, a.window?.to ?? '')} data-testid="t-ae-from" />
      <TextInput id={`t-ae-to-${i}`} type="date" aria-label={`Covering ${a.name} until`} value={a.window?.to ?? ''} disabled={!a.window?.from} onChange={(e) => setWindow(a.window?.from ?? '', e.target.value)} data-testid="t-ae-to" />
      <TextInput id={`t-ae-note-${i}`} aria-label={`Note on covering ${a.name}`} placeholder={kind === 'ooo' ? `covering for ${a.name} OOO` : kind === 'sme' ? 'SME on a Data Cloud call' : 'A note (optional)'} maxLength={120} value={a.note ?? ''} onChange={(e) => onChange({ note: e.target.value || undefined })} data-testid="t-ae-note" />
    </span>
  );
}
