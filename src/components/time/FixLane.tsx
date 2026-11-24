'use client';
/**
 * To log ▸ lane 1, **Fix or approve** (D-102; Activity-at-scale C4, AX-1, AX-3, §3.4): the rows that cannot log yet,
 * one compact line each (./CompactActivityRow.tsx), grouped so a whole group is one Accept (./fix-derive.ts).
 *
 * - Groups: by suggestion (default), or by Day | Account | Opportunity (the choice per viewer, in localStorage). A
 *   group shows 8 rows, then "Show N more in this group" / "Show all N"; at most 4 groups are open, the rest are header
 *   lines with their counts (click one to open it).
 * - The group header's "Accept N" takes those suggestions (the same PATCH Accept has always sent, one toast, one
 *   Undo). The Internal group's Accept logs its rows as internal; those the app suggests are never in the count.
 * - Keys (the kit RowGrid): j / k move across rows and group headers; Space or x ticks; Enter opens.
 * - Ticks: a row's box, a group's box (mixed when part of it is ticked), shift-click for a range, `x` or Space on a
 *   row. Ticked, the sticky bar reads "N ticked · h" with the lane's verbs: Accept suggestions · Set opp ▾ (the picker
 *   once for all of them) · Internal · Leave out. Nothing ticked, the header's button accepts every suggestion.
 * - The chevron, Enter or the title opens the details panel (useRowNav's openRow); a click on where it goes edits
 *   that row only (its pickers). Rows not found in Org62 are lane 3's and never show here.
 *
 * `FixLane` with `frame` (default) is a whole section (`#time-needs`, so old links land); C7 passes `frame={false}`
 * inside LanePage and puts `FixAcceptAll` in the lane header with `fixLane(...).count` as its count.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityEntry } from '@/contract';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { RowGrid } from '@/components/kit';
import { useArrivalHold, useLiveList } from '@/components/lists/live-list';
import { Button, cn, LivePill, SegmentedToggle, useShowMore } from '@/ui';
import { usePatchRows } from './bulk';
import { CompactActivityRow, CompactGroupHeader } from './CompactActivityRow';
import { CompactEditor } from './CompactEditor';
import { bandLabel, FIX_GROUP_BY, FIX_GROUP_BY_LABEL, FIX_STEP, fixAcceptPatch, fixLane, groupVerbLabel, initialOpen, rangeIds, tickedLine, toggleGroup, type FixBand, type FixGroup, type FixGroupBy, type FixModel } from './fix-derive';
import { OppPicker } from './OppPicker';
import { fixPatch, type InternalGroup, type NeedsYou } from './path-derive';
import { FIELD, type Pickers } from './RowParts';
import { acceptShown } from './rows-derive';
import { hasTarget } from '@/lib/time-internal';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const STORE_KEY = 'cc:time:fix-group-by';

/** The viewer's grouping, kept in localStorage (inside try/catch: private windows and previews have none). */
export function useFixGroupBy(): [FixGroupBy, (v: FixGroupBy) => void] {
  const [by, setBy] = useState<FixGroupBy>(() => {
    try {
      const v = typeof window === 'undefined' ? null : window.localStorage.getItem(STORE_KEY);
      return (FIX_GROUP_BY as readonly string[]).includes(v ?? '') ? (v as FixGroupBy) : 'suggestion';
    } catch {
      return 'suggestion';
    }
  });
  const set = useCallback((v: FixGroupBy) => {
    setBy(v);
    try {
      window.localStorage.setItem(STORE_KEY, v);
    } catch {
      /* a per-viewer convenience: without storage the choice lasts the visit */
    }
  }, []);
  return [by, set];
}

export interface FixLaneProps {
  needs: Pick<NeedsYou, 'groups'>;
  internal: Pick<InternalGroup, 'rows'>;
  tz?: string;
  /** The settle line (review-derive settleLineFor): a suggestion at or over it shows ✓. */
  settle: number;
  taskTypeRequired: boolean;
  taskTypes: string[];
  /** The persona logs internal-only work: offer Internal. */
  internalActivity?: boolean;
  /** Opens the details panel (useRowNav's openRow). */
  onOpen: (id: string) => void;
  /** Its own section and header line (`#time-needs`); false inside LanePage, whose header C7 fills. */
  frame?: boolean;
}

/**
 * Live (docs/UX.md "Live updates", C7 restores the old Needs-you hold): the shared live-list merge over every group's
 * rows, keyed by the row's id alone (R2-13): a row that changes group (you set its opp, it still lacks a type) is an
 * in-place update, never a leave and an arrival behind the pill. A row that comes in enters at its place in the AI
 * color; a row fixed elsewhere fades out where it was; while you edit or scroll the lane, arrivals wait behind the
 * pill. Never a burst hold: a scan that finds 10 shows 10.
 */
function useLiveFix(needs: Pick<NeedsYou, 'groups'>) {
  const holdRef = useRef<HTMLDivElement | null>(null);
  const hold = useArrivalHold(holdRef);
  const flat = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; kind: string; e: ActivityEntry }[] = [];
    for (const g of needs.groups)
      for (const e of g.rows) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push({ id: e.id, kind: g.kind, e });
      }
    return out;
  }, [needs.groups]);
  const live = useLiveList(flat, 'fix', { hold, tone: 'ai', burst: Infinity });
  const out = useMemo<Pick<NeedsYou, 'groups'>>(() => {
    const by = new Map<string, ActivityEntry[]>();
    for (const x of live.items) by.set(x.kind, [...(by.get(x.kind) ?? []), x.e]);
    return { groups: needs.groups.map((g) => ({ ...g, rows: by.get(g.kind) ?? [], ids: (by.get(g.kind) ?? []).map((e) => e.id) })).filter((g) => g.rows.length) };
  }, [needs.groups, live.items]);
  return { needs: out, holdRef, held: live.held.length, showHeld: live.showHeld };
}

/** Where the row being edited sat when its editor opened: its group (without rows) and that group's place. */
export interface EditPin {
  id: string;
  group: FixGroup;
  index: number;
}

/**
 * Keep the row being edited where its editor opened (R2-13): a change that moves it to another group (its opp set, a
 * type still missing) leaves it in its old group, recreated if it was the only row, until the editor closes. A row
 * that left the lane is not pinned (its editor closes).
 */
export function pinEditing(groups: readonly FixGroup[], pin: EditPin | null): FixGroup[] {
  if (!pin) return [...groups];
  const at = groups.find((g) => g.ids.includes(pin.id));
  if (!at || at.id === pin.group.id) return [...groups];
  const row = at.rows.find((e) => e.id === pin.id)!;
  const drop = (g: FixGroup): FixGroup => ({ ...g, rows: g.rows.filter((e) => e.id !== pin.id), ids: g.ids.filter((x) => x !== pin.id), accept: g.accept.filter((e) => e.id !== pin.id) });
  const out = groups.map((g) => (g.id === at.id ? drop(g) : g)).filter((g) => g.rows.length);
  const home = out.findIndex((g) => g.id === pin.group.id);
  if (home >= 0) {
    const g = out[home]!;
    const i = Math.max(0, pin.group.ids.indexOf(pin.id));
    const rows = [...g.rows];
    rows.splice(Math.min(i, rows.length), 0, row);
    out[home] = { ...g, rows, ids: rows.map((e) => e.id) };
  } else out.splice(Math.min(pin.index, out.length), 0, { ...pin.group, rows: [row], ids: [row.id], accept: [], hours: row.durationH });
  return out;
}

/** The lane header's one button with nothing ticked: "Accept N suggestions" over every row with one. */
export function FixAcceptAll({ model, taskTypeRequired, variant = 'primary' }: { model: Pick<FixModel, 'suggested'>; taskTypeRequired: boolean; variant?: 'primary' | 'secondary' }) {
  const { many, busy } = usePatchRows();
  const rows = model.suggested;
  if (!rows.length) return null;
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={busy}
      data-testid="fix-accept-all"
      title="Take the app's suggestion on each of them"
      onClick={() => void many(rows, (e) => fixAcceptPatch(e, taskTypeRequired)!, acceptSpec, (e) => (e.suggestion ? acceptShown(e.suggestion) : undefined))}
    >
      {`Accept ${plural(rows.length, 'suggestion')}`}
    </Button>
  );
}

const acceptSpec = { key: 'time:bulk-Accepted the suggestion', title: (k: number) => `Accepted the suggestion: ${plural(k, 'row')}`, body: 'Rows that now have everything move to Ready to log.' };

export function FixLane({ needs: serverNeeds, internal, tz, settle, taskTypeRequired, taskTypes, internalActivity = false, onOpen, frame = true }: FixLaneProps) {
  const pick: Pickers = { taskTypeRequired, taskTypes, internalActivity };
  const { needs, holdRef, held, showHeld } = useLiveFix(serverNeeds);
  const [by, setBy] = useFixGroupBy();
  const [pin, setPin] = useState<EditPin | null>(null);
  const editing = pin?.id ?? null;
  const base = useMemo(() => fixLane({ needs, internal, by, taskTypeRequired, settle }), [needs, internal, by, taskTypeRequired, settle]);
  // the row being edited stays in the group its editor opened in (R2-13); one that left the lane closes its editor
  const model = useMemo<FixModel>(() => ({ ...base, groups: pinEditing(base.groups, pin) }), [base, pin]);
  const gone = !!pin && !model.groups.some((g) => g.ids.includes(pin.id));
  useEffect(() => {
    if (gone) setPin(null);
  }, [gone]);
  const setEditing = useCallback(
    (id: string | null) =>
      setPin(() => {
        if (!id) return null;
        const index = model.groups.findIndex((g) => g.ids.includes(id));
        return index < 0 ? null : { id, group: model.groups[index]!, index };
      }),
    [model],
  );
  const [openIds, setOpenIds] = useState<string[] | null>(null);
  const open = useMemo(() => {
    const shown = openIds ?? initialOpen(model.groups);
    return pin && !shown.includes(pin.group.id) ? [...shown, pin.group.id] : shown;
  }, [openIds, model.groups, pin]);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const last = useRef<string | null>(null);
  const shift = useRef(false);

  const byId = useMemo(() => new Map(model.groups.flatMap((g) => g.rows.map((e) => [e.id, e] as const))), [model]);
  const sel = useMemo(() => [...ticked].map((id) => byId.get(id)).filter((e): e is ActivityEntry => !!e), [ticked, byId]);
  // the order rows show in (open groups only), for shift-click ranges
  const order = useMemo(() => model.groups.filter((g) => open.includes(g.id)).flatMap((g) => g.ids), [model, open]);

  const setMany = (ids: readonly string[], on: boolean) =>
    setTicked((cur) => {
      const next = new Set(cur);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const tickRow = (id: string) => {
    const on = !ticked.has(id);
    setMany(shift.current && last.current ? rangeIds(order, last.current, id) : [id], on);
    last.current = id;
  };

  const body = (
    <div ref={holdRef} className="flex min-w-0 flex-col" data-testid="fix-lane" onMouseDownCapture={(e) => (shift.current = e.shiftKey)} onKeyDownCapture={(e) => (shift.current = e.shiftKey)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
        <SegmentedToggle<FixGroupBy>
          label="Group by"
          value={by}
          onChange={(v) => {
            setBy(v);
            setOpenIds(null);
            setPin(null);
          }}
          options={FIX_GROUP_BY.map((v) => ({ value: v, label: FIX_GROUP_BY_LABEL[v] }))}
        />
      </div>
      <LivePill count={held} onShow={showHeld} noun={held === 1 ? 'more row' : 'more rows'} />
      {sel.length ? <TickedBar rows={sel} pick={pick} onClear={() => setTicked(new Set())} /> : null}
      {model.groups.length ? (
        // the kit's RowGrid: j / k move across rows and group headers in DOM order, as in lane 3 (R2-8)
        <div className="min-w-0" data-testid="fix-groups">
          <RowGrid label="Fix or approve">
            {model.groups.map((g, i) => (
              <Fragment key={g.id}>
                {i === 0 || model.groups[i - 1]!.band !== g.band ? <BandHeader band={g.band} n={model.bands[g.band]} internal={model.bands.internal} /> : null}
              <Group
                key={g.id}
                g={g}
                open={open.includes(g.id)}
                onToggle={() => setOpenIds(toggleGroup(open, g.id))}
                ticked={ticked}
                onTickGroup={(on) => setMany(g.ids, on)}
                onTickRow={tickRow}
                pick={pick}
                settle={settle}
                tz={tz}
                editing={editing}
                onEditing={setEditing}
                onOpen={onOpen}
              />
              </Fragment>
            ))}
          </RowGrid>
        </div>
      ) : (
        <p className="px-4 py-3 text-body text-muted" data-testid="needs-none">
          Nothing needs you: every open row has what it needs to log.
        </p>
      )}
    </div>
  );
  if (!frame) return body;
  return (
    <section id="time-needs" aria-labelledby="time-needs-h" data-testid="time-needs" data-lane="fix" className="flex min-w-0 scroll-mt-4 flex-col rounded-lg border border-line bg-surface">
      <div className="sticky top-0 z-[2] flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-t-lg border-b border-line bg-surface px-4 py-2">
        <h2 id="time-needs-h" className="text-body-lg font-bold text-fg-heading">
          Fix or approve
        </h2>
        <span className="text-body font-bold text-muted tabular-nums" data-testid="fix-count">
          {model.count}
        </span>
        <span className="min-w-0 text-caption text-muted">These can’t log until you settle where each goes. Accept a suggestion, or click where it goes to pick.</span>
        <span className="ml-auto">
          <FixAcceptAll model={model} taskTypeRequired={taskTypeRequired} />
        </span>
      </div>
      {body}
    </section>
  );
}

/** A band's header line (C11, R3-4): "Accept 12 · Internal 14" (the header's Accept N, then Internal) or "Review 62". */
function BandHeader({ band, n, internal }: { band: FixBand; n: number; internal: number }) {
  return (
    <div role="row" className={cn('flex min-w-0 items-baseline gap-2 border-b border-line px-4 pt-3 pb-1.5', band === 'review' && 'bg-surface-muted')} data-testid={`fix-band-${band}`} data-band={band}>
      <span role="rowheader" className="text-caption font-bold tracking-wide text-fg-heading uppercase tabular-nums">
        {bandLabel(band, n, internal)}
      </span>
      <span className="min-w-0 truncate text-caption text-muted">{band === 'accept' ? 'Sure suggestions: Accept takes these' : 'Not sure or no suggestion: pick each, or Accept it on its row'}</span>
    </div>
  );
}

interface GroupProps {
  g: FixGroup;
  open: boolean;
  onToggle: () => void;
  ticked: Set<string>;
  onTickGroup: (on: boolean) => void;
  onTickRow: (id: string) => void;
  pick: Pickers;
  settle: number;
  tz?: string;
  editing: string | null;
  onEditing: (id: string | null) => void;
  onOpen: (id: string) => void;
}

function Group({ g, open, onToggle, ticked, onTickGroup, onTickRow, pick, settle, tz, editing, onEditing, onOpen }: GroupProps) {
  const { one, many, busy } = usePatchRows();
  // "Dismiss all from <source>" (a repo, unmapped Drive docs, a series): a remembered rule with one Undo (Settings ▸ Time)
  const rule = useOptimisticMutation({
    route: 'dismissFromSource',
    topics: ['time', 'settings'],
    optimistic: (input, cache) => cache.patchEntity(input.body?.entryId ?? '', (x) => ({ ...x, status: 'dismissed', excludedReason: 'dismiss_rule' })),
    toast: (r) => ({ title: `Dismissed all from ${r.entity.rule.label}: ${plural(r.entity.dismissedIds.length, 'row')}`, body: 'New rows from it are dismissed too. Remove the rule in Settings ▸ Time ▸ Dismissed sources.' }),
  });
  const page = useShowMore(g.rows.length, { step: FIX_STEP });
  const n = g.ids.filter((id) => ticked.has(id)).length;
  const all = n > 0 && n === g.ids.length;
  const verb = groupVerbLabel(g);
  const header = (
    <CompactGroupHeader
      id={`fix-group-${g.id}`}
      label={g.label}
      count={g.rows.length}
      open={open}
      onToggle={onToggle}
      check={{ checked: all, mixed: n > 0 && !all, onChange: () => onTickGroup(!all), label: `Tick ${g.label}` }}
      verb={verb ? { label: verb, disabled: busy, loading: busy, testId: 'group-accept', title: g.kind === 'internal' ? 'Log them as internal work: Related To empty' : "Take the app's suggestion on each of them", onClick: () => void many(g.accept, (e) => fixAcceptPatch(e, pick.taskTypeRequired)!, acceptSpec, (e) => (e.suggestion && !e.internal ? acceptShown(e.suggestion) : undefined)) } : null}
    />
  );
  const hidden = g.rows.length - page.shown;
  return (
    <div data-fix-group={g.id} data-band={g.band} data-counted={g.counted ? undefined : 'false'} className={cn('min-w-0', g.band === 'review' && 'text-muted')}>
      {g.kind === 'internal' ? <div id="time-internal" className="scroll-mt-14">{header}</div> : header}
      {open ? (
        <>
          {g.rows.slice(0, page.shown).map((e) => {
            const patch = fixAcceptPatch(e, pick.taskTypeRequired);
            const isAccept = (!!e.suggestion && !hasTarget(e)) || (e.internal && e.status === 'proposed');
            return (
              <div key={e.id} data-fix-row={e.id} className="min-w-0">
                <CompactActivityRow
                  e={e}
                  settle={settle}
                  tz={tz}
                  groupTarget={g.target}
                  review={g.band === 'review'}
                  editor={(x) => <CompactEditor e={x} pick={pick} />}
                  editing={editing === e.id}
                  onEditingChange={(on) => onEditing(on ? e.id : null)}
                  check={{ checked: ticked.has(e.id), onChange: () => onTickRow(e.id), label: `Tick ${e.description || 'this row'}` }}
                  selected={ticked.has(e.id)}
                  verb={patch ? { label: isAccept ? 'Accept' : 'Approve', testId: 'row-accept', onClick: () => void one(e, patch, e.suggestion && !e.internal ? acceptShown(e.suggestion) : undefined) } : null}
                  menu={[
                    ...(pick.internalActivity && !e.internal ? [{ id: 'internal', label: 'Internal (no opportunity)', icon: 'check', onClick: () => void one(e, fixPatch(e, { internal: true }, pick.taskTypeRequired), { oppName: null, accountName: null }) }] : []),
                    { id: 'leave', label: 'Leave out', icon: 'close', onClick: () => void one(e, { status: 'dismissed' }) },
                    ...(e.internal && e.dismissSource ? [{ id: 'rule', label: `Dismiss all from ${e.dismissSource.label}`, icon: 'close', onClick: () => rule.mutate({ body: { entryId: e.id } }) }] : []),
                  ]}
                  onOpen={onOpen}
                />
              </div>
            );
          })}
          {hidden > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-2 text-caption tabular-nums" data-testid="group-more">
              <button type="button" className="rounded-sm font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none" onClick={page.more}>
                {`Show ${Math.min(FIX_STEP, hidden)} more in this group`}
              </button>
              {hidden > FIX_STEP ? (
                <button type="button" className="rounded-sm font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none" onClick={page.all}>
                  {`Show all ${g.rows.length}`}
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The sticky bar while rows are ticked: "N ticked · h" and the lane's verbs, each naming how many rows it acts on. */
function TickedBar({ rows, pick, onClear }: { rows: ActivityEntry[]; pick: Pickers; onClear: () => void }) {
  const { many, busy } = usePatchRows();
  const { taskTypeRequired } = pick;
  const n = rows.length;
  const accept = rows.filter((e) => !!fixAcceptPatch(e, taskTypeRequired));
  const spec = (what: string) => ({ key: `time:bulk-${what}`, title: (k: number) => `${what}: ${plural(k, 'row')}`, body: 'Rows that now have everything move to Ready to log.' });
  const done = (k: number) => {
    if (k) onClear();
  };
  const internal = async () => done(await many(rows, (e) => fixPatch(e, { internal: true }, taskTypeRequired), spec('Marked internal (no opportunity)'), { oppName: null, accountName: null }));
  return (
    <div className="sticky top-11 z-[1] flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-y border-line bg-surface px-4 py-2" data-testid="needs-bulk" role="region" aria-label="Ticked rows">
      <span className="text-body font-bold text-fg-heading tabular-nums" aria-live="polite" data-testid="needs-selected">
        {tickedLine(rows)}
      </span>
      {accept.length ? (
        <Button size="sm" variant="primary" disabled={busy} data-testid="bulk-accept" onClick={async () => done(await many(accept, (e) => fixAcceptPatch(e, taskTypeRequired)!, acceptSpec, (e) => (e.suggestion && !e.internal ? acceptShown(e.suggestion) : undefined)))}>
          {`Accept ${plural(accept.length, 'suggestion')}`}
        </Button>
      ) : null}
      <span className="inline-flex w-60 max-w-full" data-testid="bulk-opp">
        <OppPicker
          entry={rows[0]!}
          triggerLabel={busy ? 'Saving…' : `Set opp for ${plural(n, 'row')} ▾`}
          disabled={busy}
          className={cn(FIELD, 'h-8 border-line-strong font-bold text-link')}
          onPick={async (oppId, shown) => {
            if (!oppId) return;
            done(await many(rows, (e) => fixPatch(e, { oppId }, taskTypeRequired), spec(`Opportunity set to ${shown.oppName ?? 'the pick'}`), { oppName: shown.oppName, accountName: shown.accountName ?? undefined }));
          }}
          onAdded={async (entity) => {
            if (!entity.oppId) return;
            done(await many(rows.slice(1), (e) => fixPatch(e, { oppId: entity.oppId }, taskTypeRequired), spec(`Opportunity set to ${entity.oppName ?? 'the pick'}`), { oppName: entity.oppName, accountName: entity.accountName }));
          }}
          onInternal={pick.internalActivity ? internal : undefined}
        />
      </span>
      {pick.internalActivity ? (
        <Button size="sm" variant="secondary" disabled={busy} data-testid="bulk-internal" title="Work for no customer: Related To empty, an internal type" onClick={internal}>
          Internal
        </Button>
      ) : null}
      <Button size="sm" variant="quiet" disabled={busy} data-testid="bulk-leave" title="Not logged: left out by you" onClick={async () => done(await many(rows, () => ({ status: 'dismissed' }), spec('Left out')))}>
        Leave out
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear} className="ml-auto">
        Clear
      </Button>
    </div>
  );
}
