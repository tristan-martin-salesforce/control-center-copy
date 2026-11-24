'use client';
/**
 * Time ▸ Log hours: the quarter header, the page's focal point (docs/archive/2026-build/time-redesign.md). It tells the truth
 * plainly, in one card:
 *
 *   left   logged in Org62 against the target (verified by read-back as a quiet caption), hours to go, the meter
 *          and the pace; the deadline as a badge only when it is close or past
 *   right  waiting on you this quarter (need you, ready to log: hours, rows, each a jump to its section), and one
 *          quiet line "N batches in flight ▸ Sending"
 *
 * F4 (R2-4, D-102): History owns the past only. A batch's life is told once, on To log ▸ Sending: the card never says
 * "to apply" or "to send", lists no batch still in flight, and the "landed in" lines live on History ▸ Batches.
 *
 * The not-in-Org62 strip moved to To log ▸ Sending (./SendingLane.tsx, C6): a row Org62 lacks sits on its batch.
 *
 * "Human hours only" is a quiet last line, not a headline. A role without a quarter target (the AE) shows the
 * hours alone: no meter, no pace.
 */
import { usePersona } from '@/client/persona';
import { StatusBadge } from '@/components/domain';
import { clock, dayLabel } from '@/components/domain/lib/time';
import { AppLink } from '@/components/shell/AppLink';
import { cn } from '@/ui';
import { fmtH, ymdIn } from './derive';
import { cardWaiting, inFlightLine } from './history-derive';
import { rowsWord, type QuarterPart, type QuarterTruth } from './path-derive';
import { hrefForAnchor, LOG_ANCHORS } from './views';

function dueLabel(due: string | null, nowIso: string, tz?: string): string | null {
  if (!due) return null;
  const today = ymdIn(nowIso, tz);
  const day = ymdIn(due, tz);
  const tomorrow = ymdIn(new Date(Date.parse(nowIso) + 86_400_000).toISOString(), tz);
  const when = day === today ? 'today' : day === tomorrow ? 'tomorrow' : dayLabel(due, tz);
  return `Due ${when} ${clock(due, tz)}`;
}

export interface QuarterHeaderProps {
  truth: QuarterTruth;
  due: string | null;
  now: string;
  tz?: string;
  /** Scroll to the section a part lives in (Needs you, or Log it). */
  onJump: (part: QuarterPart['id']) => void;
  /** DC requests and VDP use cases waiting for a canvas (they are not rows, so they never show as hours). */
  queued?: { dcs: number; useCases: number };
  /** Batches still in To log ▸ Sending (history-derive `inFlightCount`): one quiet link, never their progress. */
  inFlight?: number;
}

/** "55 DC requests and 3 VDP use cases wait for a canvas" (null: none). */
export function queuedLine(q: { dcs: number; useCases: number } | undefined): string | null {
  if (!q || (!q.dcs && !q.useCases)) return null;
  const parts = [q.dcs ? `${q.dcs} DC ${q.dcs === 1 ? 'request' : 'requests'}` : null, q.useCases ? `${q.useCases} VDP use ${q.useCases === 1 ? 'case' : 'cases'}` : null].filter(Boolean);
  return `${parts.join(' and ')} ${q.dcs + q.useCases === 1 ? 'waits' : 'wait'} for a batch`;
}

/**
 * To log's header line (C7, §3.4): the quarter card in one sentence, the card's own words.
 * "Q4 FY27 · 27.5 of 60 h in Org62 · on pace · due Thu 12:00". The full card is History's (C8 mounts QuarterHeader).
 */
export function quarterSentence(t: Pick<QuarterTruth, 'label' | 'loggedH' | 'targetH' | 'pace' | 'tone'>, due: string | null, now: string, tz?: string): string {
  const logged = Math.round(t.loggedH * 10) / 10;
  const dueText = dueLabel(due, now, tz);
  const pace = t.pace ? (t.pace.state === 'behind' ? `${Math.abs(t.pace.deltaH)} h behind pace` : t.pace.state === 'ahead' ? `${t.pace.deltaH} h ahead of pace` : 'on pace') : null;
  return [t.label, t.targetH > 0 ? `${logged} of ${t.targetH} h in Org62` : `${logged} h in Org62`, t.targetH > 0 ? pace : null, dueText ? (t.tone === 'danger' ? `past due ${dueText.replace(/^Due /, '')}` : `due ${dueText.replace(/^Due /, '')}`) : null].filter(Boolean).join(' · ');
}

export function QuarterHeader({ truth: t, due, now, tz, onJump, queued, inFlight }: QuarterHeaderProps) {
  const persona = usePersona();
  const queuedText = queuedLine(queued);
  const waiting = cardWaiting(t.waiting);
  const flight = inFlightLine(inFlight);
  const dueText = dueLabel(due, now, tz);
  const target = t.targetH > 0;
  return (
    <section aria-labelledby="q4-h" data-testid="q4-log" className="@container/qh flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface p-5">
      <div className="grid min-w-0 gap-x-10 gap-y-5 @min-[50rem]/qh:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h2 id="q4-h" className="text-lead font-bold text-fg-heading">
              {t.label}
            </h2>
            {dueText ? (
              t.tone === 'none' ? (
                <span className="text-caption text-muted">{dueText}</span>
              ) : (
                <StatusBadge tone={t.tone} icon="clock">
                  {t.tone === 'danger' ? `Past due · ${dueText.replace(/^Due /, '')}` : dueText}
                </StatusBadge>
              )
            ) : null}
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-2 tabular-nums" data-testid="q4-logged">
            <span className="text-heading font-bold text-fg-heading">{Math.round(t.loggedH * 10) / 10} h</span>
            <span className="text-body text-muted">{target ? `logged in Org62 of ${t.targetH} h` : 'logged in Org62 this quarter'}</span>
          </div>
          {target ? (
            <div className="cx-meter mt-2" data-tone={t.tone === 'none' ? undefined : t.tone} role="meter" aria-label={`${t.loggedH} of ${t.targetH} hours logged`} aria-valuenow={Math.round(t.pct)} aria-valuemin={0} aria-valuemax={100}>
              <i style={{ width: `${t.pct}%` }} />
            </div>
          ) : null}
          <p className="mt-1.5 text-caption text-muted tabular-nums">
            {[t.verifiedH !== null ? `${fmtH(t.verifiedH)} checked in Org62` : null, target ? (t.leftH > 0 ? `${t.leftH} h to go` : 'Target met') : null].filter(Boolean).join(' · ') || 'Read back from Org62'}
          </p>
          {t.pace ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted tabular-nums" data-pace={t.pace.state}>
              {t.pace.state === 'behind' ? (
                <StatusBadge tone="warning" icon="clock">{`${Math.abs(t.pace.deltaH)} h behind pace`}</StatusBadge>
              ) : (
                <span className="font-bold text-fg">{t.pace.state === 'ahead' ? `${t.pace.deltaH} h ahead of pace` : 'On pace'}</span>
              )}
              <span>{`${t.pace.expectedH} h expected by today · ${t.pace.workdaysLeft} workdays left`}</span>
            </p>
          ) : null}
        </div>

        <div className="min-w-0" data-testid="q4-waiting">
          <h3 className="text-caption font-bold text-muted">Waiting on you this quarter</h3>
          {waiting.rows ? (
            <>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-2 tabular-nums">
                <span className="text-title font-bold text-fg-heading">{fmtH(waiting.hours)}</span>
                <span className="text-body text-muted">{rowsWord(waiting.rows)}</span>
              </div>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-caption tabular-nums" aria-label="Where they wait">
                {waiting.parts.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => onJump(p.id)} data-part={p.id} className="rounded-sm font-bold text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus">
                      {`${fmtH(p.hours)} ${p.label}`}
                    </button>
                    <span className="text-muted">{` · ${rowsWord(p.rows)}`}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : queuedText ? null : (
            <p className="mt-1 text-body text-fg">Nothing: every row of {t.label} is in Org62 or on its way.</p>
          )}
          {queuedText ? (
            // 2026-11-13 audit C2: DCs and use cases waiting are work too, never "Nothing"
            <p className="mt-1 text-caption tabular-nums" data-testid="q4-queued">
              <button type="button" onClick={() => onJump('ready')} className="rounded-sm font-bold text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus">
                {queuedText}
              </button>
              <span className="text-muted"> · in To log ▸ Ready to log, for your next batch</span>
            </p>
          ) : null}
          {flight ? (
            <p className="mt-3 text-caption text-muted tabular-nums" data-testid="q4-in-flight">
              {`${flight} `}
              <AppLink href={hrefForAnchor(LOG_ANCHORS.runs, persona)} className="font-bold text-link hover:underline">
                ▸ Sending
              </AppLink>
            </p>
          ) : null}
        </div>
      </div>
      <p className={cn('text-caption text-faint')}>Human hours only; agent time never counts.</p>
    </section>
  );
}
