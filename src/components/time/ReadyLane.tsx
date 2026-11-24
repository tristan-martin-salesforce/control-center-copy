'use client';
/**
 * Lane 2, Ready to log (D-102; Activity-at-scale C5, AX-4, §3.3, §3.4): what I approved, and what the app is sure of,
 * waiting to be logged. Ticks are on the lane; one button logs (./ready-derive.ts is the layout, ./review-derive.ts
 * the ticks and the stage, ./use-ready-log.ts the state and the one write).
 *
 *   READY FOR ORG62 · 12 rows · 14.5 h · 1 use case   12 rows · 14.5 h · 0 of 1 use case ticked  [Log 12 rows · 14.5 h]
 *   ☑ ▾ Mon, Nov 16 · 4.5 h  3                         (a group: its tick ticks its rows; its label opens or folds it)
 *     ☑ Mon 16 09:00  ACME weekly sync         1 h   ACME · Platform            ›
 *     ☐ Mon 16 13:00  Slack with initech       1 h   50% likely Initech · D360  ›   (where: the likely opps inline)
 *   ☐ ▸ Use cases  29 · ☐ ▸ Events in Org62  3            (rows of their own; ticked once their group is open)
 *
 * - Ticked when the app is sure (at or over the settle line), unticked when it guesses or can't settle the opp. A
 *   click on an unsure row's where cell opens its likely opps; **Log it here** sets it and ticks it. Other rows' where
 *   cell opens the pickers (CompactEditor).
 * - Grouped by day (how Org62 reads it) or by account (per viewer). 8 rows a group, then Show more; at most four
 *   groups open, the rest as header lines with their counts.
 * - **Log N · h** re-reads the ticked rows, saves the suggestions it takes and stages ONE batch for my Apply (D-47);
 *   the result line says what was staged and that nothing was sent, with Review & apply and Back.
 * - On To log the use-case and Event-change groups are header lines, unticked, until opened (click the label); opening
 *   one ticks its items once, and the group's tick ticks them all. On the Review page they are open and ticked. A
 *   one-row group has no toggle. The header counts what the button can log ("2 rows · 2 h · 29 use cases"), and the
 *   button says what it stages ("Log 2 rows · 29 use cases", F3).
 * - `full` is the Review page (`?review=1`): the same lane at full width, same header count and button, with Back
 *   (Esc) and the keys Space ticks, j / k move, Enter opens, `a` logs; it also lists the unsure rows a pick can tick
 *   (F5, R2-6), never counted.
 * Nothing is sent from here.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import type { ActivityEntry, EventUpdateRow, UseCaseLanding } from '@/contract';
import { useDetails } from '@/components/deals/context-frame';
import { dayLabel } from '@/components/domain/lib/time';
import { ActionRow } from '@/components/kit';
import { navigate } from '@/components/shell/router';
import { Button, Kbd, SegmentedToggle } from '@/ui';
import { CompactActivityRow, CompactGroupHeader } from './CompactActivityRow';
import { CompactEditor } from './CompactEditor';
import { dcContextChips, dcContextDetails } from './DcSuggestions';
import { fmtH } from './derive';
import { OppRundown } from './OppRundown';
import { LOG_ANCHORS } from './views';
import { defaultOpen, extraGroups, seenItems, groupTick, type ExtraGroup, laneButton, laneCount, READY_STEP, readGroupBy, readyGroups, tickable, tickedLine, writeGroupBy, type ReadyGroup, type ReadyGroupBy } from './ready-derive';
import { canCheck, canTickExtra, resultLines, reviewKey, type ReviewEntry } from './review-derive';
import type { Pickers } from './RowParts';
import { useReadyLog } from './use-ready-log';

const EDITABLE = 'input,textarea,select,[contenteditable="true"],[role="combobox"],[role="listbox"]';

export interface ReadyLaneProps {
  /** Rows ready to log (lanesOf's `ready`: approved, or complete and proposed while "approve complete" is on). */
  ready: readonly ActivityEntry[];
  /**
   * Rows that only lack their opportunity: the Review page passes the unsure ones with likely opps (a pick ticks them in
   * place; ./review-derive.ts `reviewPickRows`), never counted in the header; the lane on To log leaves them to lane 1.
   */
  needOpp?: readonly ActivityEntry[];
  /** Use cases ready for Org62 and changes to Events already there: ticked like rows. */
  useCases?: readonly UseCaseLanding[];
  updates?: readonly EventUpdateRow[];
  pick: Pickers;
  dryRun: boolean;
  /** The rows as they are now on the server (the re-check before staging). */
  loadFresh: () => Promise<ActivityEntry[]>;
  /** Opens a row in the details panel. */
  onOpen: (id: string) => void;
  tz?: string;
  /** The Review page: full width, Back (Esc) and `a`. */
  full?: boolean;
  /** Back to To log (the Review page's Back and Esc). */
  onExit?: () => void;
  /** The lane's state when the page holds it (C7: To log's LanePage header carries the Log button). */
  log?: ReadyLog;
  /** Draw the sticky header (count and Log button) here (default); false inside LanePage, whose header has them. */
  header?: boolean;
}

/** The extras groups that start as header lines on To log (R3-2; the Review page opens them). */
const FOLDED_AT_FIRST = ['useCase', 'update'] as const;

const EXTRA_TESTID = { dc: 'ready-dcs', useCase: 'ready-use-cases', update: 'ready-updates' } as const;

/** A DC row's Accept and Reject (the same route DcSuggestions uses; one toast with Undo; nothing is sent). */
function useDcDecide() {
  const m = useOptimisticMutation({
    route: 'decideDcSuggestion',
    topics: ['time', 'deals'],
    toast: (r, input) => (input.body?.decision === 'reject' ? { title: `Not suggested again: ${r.entity.suggestion.oppName}`, body: 'Unless 2 h more land on it, or you join its team.' } : { title: `DC request drafted: ${r.entity.suggestion.oppName}`, body: 'It goes in your next batch. Nothing is sent until you Apply it.' }),
  });
  return { busy: m.isPending, decide: (id: string, decision: 'accept' | 'reject') => m.mutate({ params: { id }, body: { decision } }) };
}

export type ReadyLog = ReturnType<typeof useReadyLog>;

/**
 * Lane 2's one button for LanePage's header (C7): "Log N · h", stages one batch for my Apply. R3-5: what is ticked sits
 * beside it, per kind of what the header counts ("2 rows · 2 h · 2 DCs · 8 of 29 use cases ticked"), or why it is off.
 */
export function ReadyLogButton({ log: s }: { log: ReadyLog }) {
  if (s.result || (!s.rows.length && !s.extras.length)) return null;
  const button = laneButton(s.rows, s.checked, s.extras);
  return (
    <>
      <TickedBeside rows={s.rows} checked={s.checked} extras={s.extras} button={button} />
      <Button variant="primary" size="sm" disabled={button.disabled} loading={s.busy} title={button.why ?? 'Stages one batch for your Apply. Nothing is sent.'} onClick={() => void s.logThese()} data-testid="review-log">
        {button.label}
      </Button>
    </>
  );
}

/** The ticked line (or why the button is off), drawn next to the button wherever the button is. */
function TickedBeside({ rows, checked, extras, button }: Pick<ReadyLog, 'rows' | 'checked' | 'extras'> & { button: ReturnType<typeof laneButton> }) {
  if (button.count > 0)
    return (
      <span className="min-w-0 text-caption text-muted tabular-nums" data-testid="review-summary">
        {tickedLine(rows, checked, extras)}
      </span>
    );
  return button.why && (rows.length || extras.length) ? (
    <span className="min-w-0 text-caption font-bold text-fg" data-testid="review-why">
      {button.why}
    </span>
  ) : null;
}

const dayName = (date: string) => dayLabel(`${date}T12:00:00Z`, 'UTC');

export function ReadyLane(props: ReadyLaneProps) {
  return props.log ? <ReadyLaneView {...props} s={props.log} /> : <OwnReadyLane {...props} />;
}

function OwnReadyLane(props: ReadyLaneProps) {
  const { ready, needOpp, useCases, updates, pick, loadFresh } = props;
  const s = useReadyLog({ ready, needOpp, useCases, updates, taskTypeRequired: pick.taskTypeRequired, loadFresh });
  return <ReadyLaneView {...props} s={s} />;
}

function ReadyLaneView({ pick, dryRun, onOpen, tz, full = false, onExit, header = true, s }: ReadyLaneProps & { s: ReadyLog }) {
  const { rows, extras, checked } = s;
  const dc = useDcDecide();
  const { open: openDetails } = useDetails();
  const [by, setBy] = useState<ReadyGroupBy>('day');
  useEffect(() => setBy(readGroupBy()), []);
  const groups = useMemo(() => readyGroups(rows, by), [rows, by]);
  const [open, setOpen] = useState<Set<string> | null>(null);
  // a one-row group has no toggle: it is always open
  const isOpen = (g: ReadyGroup) => g.rows.length === 1 || (open ?? defaultOpen(groups)).has(g.key);
  const toggleGroup = (g: ReadyGroup) =>
    setOpen((cur) => {
      const next = new Set(cur ?? defaultOpen(groups));
      if (next.has(g.key)) next.delete(g.key);
      else next.add(g.key);
      return next;
    });
  const [shown, setShown] = useState<Record<string, number>>({});
  // C11: DCs, use cases and Event changes are first-class groups. R3-2: on To log the use cases and Event changes start
  // as header lines, unticked until opened (F3), so Sending stays above the fold; DCs open; on Review all are open
  const [extrasFolded, setExtrasFolded] = useState<Set<string>>(() => new Set(FOLDED_AT_FIRST));
  const xGroups = useMemo(() => extraGroups(extras), [extras]);
  const extraOpen = (g: ExtraGroup) => full || g.items.length === 1 || !extrasFolded.has(g.key);
  // F3 (R2-3), per group: the items a user has seen (open, shown) are ticked once each; folded or not yet shown, unticked
  const { reveal } = s;
  useEffect(() => {
    for (const g of xGroups) reveal(seenItems(g, extraOpen(g), full ? g.items.length : (shown[g.key] ?? READY_STEP)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- extraOpen reads extrasFolded and full, listed
  }, [xGroups, extrasFolded, full, reveal, shown]);
  const toggleExtra = (key: string) =>
    setExtrasFolded((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const [editing, setEditing] = useState<string | null>(null);
  // a DC row's where cell opens the details under it: whose forecast names the deal, who holds a DC, the specialists
  const [dcOpen, setDcOpen] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (full) root.current?.focus({ preventScroll: true });
  }, [full]);

  const button = laneButton(rows, checked, extras);
  const back = full ? onExit : s.clearResult;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.closest(EDITABLE)) return;
    if (e.key === 'Escape' && full) {
      e.preventDefault();
      onExit?.();
      return;
    }
    const k = reviewKey(e.key);
    if (!k || s.result) return;
    const rowEl = target.closest<HTMLElement>('[data-review-row]');
    const all = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-review-row]') ?? []);
    if (k === 'log') {
      if (!full) return;
      void s.logThese();
    } else if (k === 'next' || k === 'prev') {
      if (!full && !rowEl) return;
      const i = rowEl ? all.indexOf(rowEl) : -1;
      (all[k === 'next' ? i + 1 : Math.max(0, i - 1)] ?? all[0])?.focus();
    } else if (k === 'toggle') {
      if (target.closest('button,a')) return;
      const id = rowEl?.dataset.reviewRow;
      if (!id) return;
      const r = rows.find((x) => x.id === id);
      if (r) s.toggle(r);
      else if (extras.some((x) => x.id === id && canTickExtra(x))) s.flip(id);
    } else return; // Enter is the row's own (it opens the details panel)
    e.preventDefault();
  };

  if (s.result) {
    const lines = resultLines(s.result, dryRun);
    const draftId = s.result.draftIds[0];
    return (
      <div ref={root} tabIndex={-1} className="flex min-w-0 flex-col gap-4 outline-none" data-testid="review-result" onKeyDown={onKeyDown}>
        <section className="flex max-w-3xl flex-col gap-2 rounded-lg border border-line bg-surface p-5 shadow-raise">
          <h2 className="text-heading font-bold text-fg-heading">{lines.title}</h2>
          {lines.body.map((l) => (
            <p key={l} className="text-body text-fg">
              {l}
            </p>
          ))}
          <div className="mt-2 flex flex-wrap gap-2">
            {draftId ? (
              <Button variant="primary" size="sm" onClick={() => openDetails({ kind: 'draft', id: draftId, label: 'Logging batch' })} data-testid="review-open-batch">
                Review &amp; apply
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" onClick={() => back?.()} data-testid="review-back">
              {full ? 'Back to To log' : 'Back'}
            </Button>
          </div>
        </section>
      </div>
    );
  }

  const renderRow = (r: ReviewEntry) => {
    const e = r.entry;
    const name = e.description || 'this row';
    return (
      <CompactActivityRow
        key={r.id}
        e={e}
        tz={tz}
        settle={s.settle}
        attrs={{ 'data-review-row': r.id, 'data-ready-row': r.id, 'data-kind': r.kind }}
        check={{ checked: checked.has(r.id) && canCheck(r), onChange: () => s.toggle(r), label: canCheck(r) ? `Log ${name}` : `Pick where ${name} goes first` }}
        selected={checked.has(r.id) && canCheck(r)}
        editor={(x) => (r.kind === 'unsure' ? <OppRundown e={x} onPick={(oppId) => void s.pick(r, oppId).then(() => setEditing(null))} /> : <CompactEditor e={x} pick={pick} />)}
        menu={r.dc ? [{ id: 'dc', label: `${r.coveredAe ? `${r.coveredAe}’s deal: ` : ''}DC to claim${r.dc.splitPercent ? ` · ${r.dc.splitPercent}%` : ''}`, icon: 'chevronright', title: r.dc.reasons.map((x) => x.text).join(' · ') || undefined, onClick: () => navigate('/deals/dcs'), testId: 'ready-dc' }] : undefined}
        editing={editing === r.id}
        onEditingChange={(on) => setEditing(on ? r.id : null)}
        onOpen={onOpen}
      />
    );
  };

  return (
    <div ref={root} tabIndex={-1} onKeyDown={onKeyDown} data-testid={full ? 'log-review' : 'ready-lane'} aria-label={full ? 'Review what to log' : undefined} role={full ? 'region' : undefined} className="flex min-w-0 flex-col gap-3 outline-none">
      <div className={header ? 'sticky top-0 z-10 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line bg-surface px-4 py-2.5' : 'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2'}>
        {header ? (
          <>
            <h2 id={full ? undefined : 'time-ready-h'} className="text-caption font-bold tracking-wide text-fg-heading uppercase">
              Ready for Org62
            </h2>
            <span className="text-caption text-muted tabular-nums" data-testid="ready-count">
              {laneCount(rows, extras)}
            </span>
          </>
        ) : null}
        {rows.length ? (
          <SegmentedToggle<ReadyGroupBy>
            label="Group by"
            value={by}
            onChange={(v) => {
              setBy(v);
              setOpen(null);
              setShown({});
              writeGroupBy(v);
            }}
            options={[
              { value: 'day', label: 'Day' },
              { value: 'account', label: 'Account' },
            ]}
          />
        ) : null}
        <span className="min-w-0 flex-1" />
        {/* inside LanePage the ticked line sits beside the header's button (ReadyLogButton) */}
        {header ? <TickedBeside rows={rows} checked={checked} extras={extras} button={button} /> : null}
        {full ? (
          <Button variant="quiet" size="sm" onClick={() => onExit?.()} kbd="esc" data-testid="review-exit">
            Back
          </Button>
        ) : null}
        {header && (rows.length || extras.length) ? (
          <Button variant="primary" size="sm" disabled={button.disabled} loading={s.busy} title={button.why ?? 'Stages one batch for your Apply. Nothing is sent.'} onClick={() => void s.logThese()} kbd={full && !button.disabled ? 'a' : undefined} data-testid="review-log">
            {button.label}
          </Button>
        ) : null}
      </div>
      {s.notice ? (
        <p role="alert" className="rounded-md border border-warning-500 bg-surface px-4 py-2.5 text-body text-fg" data-testid="review-notice">
          {s.notice}
        </p>
      ) : null}
      {!rows.length && !extras.length ? <p className="px-4 text-body text-muted">Nothing is ready to log right now. Rows come in as the scans find your meetings and work; what still needs you stays on To log.</p> : null}
      {groups.length || extras.length ? (
        <div role="grid" aria-label="Rows ready to log" className="min-w-0 rounded-lg bg-surface px-1">
          {groups.map((g) => {
            const ids = tickable(g.rows);
            const t = groupTick(ids, checked);
            const label = by === 'day' ? `${dayName(g.key)} · ${fmtH(g.hours)}` : `${g.label} · ${fmtH(g.hours)}`;
            const on = isOpen(g);
            const n = shown[g.key] ?? READY_STEP;
            const more = g.rows.length - n;
            return (
              <div key={g.key} role="rowgroup" aria-label={by === 'day' ? dayName(g.key) : g.label} data-ready-day={by === 'day' ? g.key : undefined} data-ready-group={g.key}>
                <CompactGroupHeader
                  id={`ready-group-${g.key}`}
                  label={label}
                  count={g.rows.length}
                  check={ids.length ? { checked: t.checked, mixed: t.mixed, onChange: () => s.setMany(ids, !t.checked), label: `Log every row in ${by === 'day' ? dayName(g.key) : g.label}` } : undefined}
                  open={on}
                  onToggle={g.rows.length > 1 ? () => toggleGroup(g) : undefined}
                />
                {on ? (
                  <>
                    {g.rows.slice(0, n).map(renderRow)}
                    {more > 0 ? (
                      <div className="flex items-center gap-3 px-3 py-1.5 text-caption">
                        <button type="button" className="font-bold text-link hover:underline" onClick={() => setShown((c) => ({ ...c, [g.key]: n + READY_STEP }))} data-testid="ready-show-more">
                          {`Show ${Math.min(more, READY_STEP)} more`}
                        </button>
                        {more > READY_STEP ? (
                          <button type="button" className="text-link hover:underline" onClick={() => setShown((c) => ({ ...c, [g.key]: g.rows.length }))}>
                            {`Show all ${g.rows.length}`}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
          {xGroups.map((g) => {
            const ids = g.items.filter(canTickExtra).map((x) => x.id);
            const t = groupTick(ids, checked);
            const on = extraOpen(g);
            const n = full ? g.items.length : (shown[g.key] ?? READY_STEP);
            const anchor = g.key === 'dc' ? LOG_ANCHORS.dcs : g.key === 'useCase' ? LOG_ANCHORS.useCases : undefined;
            return (
              <div key={g.key} id={anchor} role="rowgroup" aria-label={g.label} className="min-w-0 scroll-mt-14" data-testid={EXTRA_TESTID[g.key]} data-ready-kind={g.key}>
                <CompactGroupHeader
                  id={`ready-group-${g.key}`}
                  label={g.label}
                  count={g.items.length}
                  check={ids.length ? { checked: t.checked, mixed: t.mixed, onChange: () => s.setMany(ids, !t.checked), label: `Log every one of ${g.label}` } : undefined}
                  open={on}
                  onToggle={full || g.items.length === 1 ? undefined : () => toggleExtra(g.key)}
                />
                {(on ? g.items.slice(0, n) : []).map((x) => {
                  // R3-7: who else is on the deal, where Accept happens ("2 Data & AI DCs: … · via Morgan Hale’s forecast")
                  const chips = x.kind === 'dc' ? dcContextChips(x.dc?.context) : [];
                  const details = x.kind === 'dc' ? dcContextDetails(x.dc?.context) : [];
                  return (
                    <Fragment key={x.id}>
                      <ActionRow
                        id={x.id}
                        density="compact"
                        data-review-row={x.id}
                        data-kind={x.kind}
                        title={x.title}
                        where={
                          <span className="min-w-0 truncate text-muted">
                            {chips.map((c) => (
                              <span key={c.key} className="text-fg" data-context={c.key}>{`${c.text} · `}</span>
                            ))}
                            {x.why}
                            {x.note ? <span data-testid="dc-from-time">{` · ${x.note}`}</span> : null}
                          </span>
                        }
                        whereLabel={[...chips.map((c) => c.text), x.why, x.note].filter(Boolean).join(' · ')}
                        onEditingChange={details.length ? () => setDcOpen((cur) => (cur === x.id ? null : x.id)) : undefined}
                        check={{ checked: checked.has(x.id) && canTickExtra(x), onChange: () => s.flip(x.id), label: x.locked ? `${x.title}: ${x.locked}` : `Log ${x.title}` }}
                        selected={checked.has(x.id) && canTickExtra(x)}
                        dashed={x.kind === 'dc' && !x.preTicked}
                        verb={x.kind === 'dc' && dc ? { label: x.locked ? 'Edit' : 'Accept', testId: 'dc-accept', disabled: dc.busy, title: x.locked ? 'Agree the split in Deals ▸ DCs' : 'A DC request for your next batch. Nothing is sent until you apply it.', onClick: () => (x.locked ? navigate('/deals/dcs') : dc.decide(x.ref, 'accept')) } : null}
                        overflow={x.kind === 'dc' && dc ? [{ id: 'reject', label: 'Reject', icon: 'close', testId: 'dc-reject', onClick: () => dc.decide(x.ref, 'reject') }, { id: 'edit', label: 'Edit the split or comment', icon: 'chevronright', onClick: () => navigate('/deals/dcs') }] : undefined}
                      />
                      {dcOpen === x.id && details.length ? (
                        <div role="row" className="py-1 pr-3 pl-12" data-testid="dc-context">
                          <div role="gridcell">
                            <ul className="space-y-0.5 text-caption text-muted">
                              {details.map((line) => (
                                <li key={line}>{line}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      ) : null}
                    </Fragment>
                  );
                })}
                {on && g.items.length > n ? (
                  <div className="flex items-center gap-3 px-3 py-1.5 text-caption">
                    <button type="button" className="font-bold text-link hover:underline" onClick={() => setShown((c) => ({ ...c, [g.key]: n + READY_STEP }))} data-testid="ready-show-more">
                      {`Show ${Math.min(g.items.length - n, READY_STEP)} more`}
                    </button>
                    {g.items.length - n > READY_STEP ? (
                      <button type="button" className="text-link hover:underline" onClick={() => setShown((c) => ({ ...c, [g.key]: g.items.length }))}>
                        {`Show all ${g.items.length}`}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <p className="flex flex-wrap items-center gap-x-2 px-4 text-caption text-muted">
        {full ? (
          <>
            <Kbd>space</Kbd> tick <Kbd>j</Kbd>
            <Kbd>k</Kbd> move <Kbd>⏎</Kbd> open <Kbd>a</Kbd> log ·{' '}
          </>
        ) : null}
        {dryRun ? 'Dry run is on: Apply will only show what would go to Org62.' : 'One batch, and nothing goes to Org62 until you apply it.'}
      </p>
    </div>
  );
}
