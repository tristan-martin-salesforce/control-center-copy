/**
 * Time rows as engagement touches (engagement.ts): one touch per live row, its kind from its first source, its hours
 * only when it is approved or later and on an opp, and the engine's ranked alternates for a row with no opp (a Slack
 * burst, a meeting the rules couldn't place). Internal-only rows credit nothing. Pure: the db's nightly rollup and the
 * mock compute the same touches from the same rows.
 */
import type { ActivityEntry } from '@/contract';
import { rowAttribution, type RowContext } from './row';
import type { EngagementTouch, TouchKind } from './engagement';

const LOGGED = new Set<ActivityEntry['status']>(['approved', 'synced_to_canvas', 'logged', 'verified', 'verify_failed']);
const COUNTED = new Set<ActivityEntry['status']>(['needs_input', 'proposed', ...LOGGED]);
const KIND_OF: Record<string, TouchKind> = { calendar: 'meeting', slack: 'slack', gmail: 'mail', email: 'mail', drive: 'doc', claude: 'session', gemini_notes: 'note' };

export function touchesOf(entries: readonly ActivityEntry[], ctx: RowContext, from: string): EngagementTouch[] {
  const accountByName = new Map(ctx.accounts.map((a) => [a.name.trim().toLowerCase(), a.id] as const));
  const out: EngagementTouch[] = [];
  for (const e of entries) {
    if (e.date < from || !COUNTED.has(e.status) || e.internal) continue;
    const kind: TouchKind = KIND_OF[e.sources[0]?.kind ?? ''] ?? 'logged';
    const accountId = e.accountName ? (accountByName.get(e.accountName.trim().toLowerCase()) ?? null) : null;
    const candidates = e.oppId
      ? []
      : rowAttribution(e, ctx)
          .attribution.candidates.filter((c) => c.kind === 'opp' && c.oppId)
          .map((c) => ({ oppId: c.oppId!, score: c.confidence }));
    out.push({
      kind,
      at: e.start,
      day: e.date,
      oppId: e.oppId,
      accountId,
      candidates,
      external: e.meetingType === 'CF',
      ...(e.oppId && LOGGED.has(e.status) ? { hours: e.durationH } : {}),
      ref: { label: e.description || e.oppName || 'Activity', url: e.sources.find((s) => s.url)?.url ?? null },
    });
  }
  return out;
}
