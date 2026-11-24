'use client';
/**
 * The Ready lane's state and its one write (extracted from the Review page, C5): the rows (./review-derive.ts), the
 * ticks (ticked at the settle line; a row that arrives later is ticked by the same rule, once; use cases and Event
 * changes only once their group is open, `reveal`), the pick on an unsure
 * row, and "Log N": re-read the ticked rows (a row whose opp changed elsewhere, or that left, is unticked and named;
 * nothing is staged until a second press), save the suggestions it takes (one save each, like Accept), then stage ONE
 * batch for my Apply (D-47; POST /time/log/batches with exactly the ticked ids). C11: the DCs to claim are items of
 * the same lane; Log claims the ticked ones first (each a DC request that rides this batch), then stages it. A time
 * answer that sets an opp brings that opp's DC in (the DC list is re-read on the time topic; `timeRows` names the day
 * it came from). Nothing is sent from here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityEntry, EventUpdateRow, StageLogBatchResult, UseCaseLanding } from '@/contract';
import { api } from '@/client/api';
import { useApi } from '@/client/hooks';
import { usePersona } from '@/client/persona';
import { errorText } from '@/lib/error-text';
import { featureActive } from '@/personas/gates';
import { usePatchRows } from './bulk';
import { fixPatch } from './path-derive';
import { acceptPatch } from './rows-derive';
import { canCheck, canTickExtra, changeNotice, dcsToClaim, initialChecked, logButton, recheck, reviewEntries, reviewExtras, settleLineFor, snapshotOf, stageRequest, type ReviewEntry, type ReviewExtra, type ReviewSnapshot } from './review-derive';

export interface ReadyLogInput {
  ready: readonly ActivityEntry[];
  needOpp?: readonly ActivityEntry[];
  useCases?: readonly UseCaseLanding[];
  updates?: readonly EventUpdateRow[];
  /** Every time row of the quarter: a DC's "from your time on <date>". */
  timeRows?: readonly ActivityEntry[];
  taskTypeRequired: boolean;
  /** The rows as they are now on the server (the re-check before staging). */
  loadFresh: () => Promise<ActivityEntry[]>;
}

export function useReadyLog({ ready, needOpp = [], useCases, updates, timeRows, taskTypeRequired, loadFresh }: ReadyLogInput) {
  const persona = usePersona();
  const dcOn = featureActive(persona, 'dealContributions');
  const dcs = useApi('getDcSuggestions', undefined, { enabled: dcOn });
  const settle = settleLineFor(persona);
  const rows = useMemo(() => reviewEntries({ ready, needOpp, dcs: dcs.data?.suggestions ?? [], settle, taskTypeRequired }), [ready, needOpp, dcs.data, settle, taskTypeRequired]);
  const extras = useMemo(() => reviewExtras(useCases, updates, dcOn ? (dcs.data?.suggestions ?? []) : [], timeRows ?? ready), [useCases, updates, dcOn, dcs.data, timeRows, ready]);
  const { one } = usePatchRows();
  const lockedRef = useRef(new Set<string>());
  lockedRef.current = new Set(extras.filter((x) => !canTickExtra(x)).map((x) => x.id));

  // F3 (R2-3): use cases and Event changes start unticked; the lane ticks a group's items once, when it is open (reveal)
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initialChecked(rows)));
  const snapshot = useRef<ReviewSnapshot>(snapshotOf(rows));
  const revealed = useRef(new Set<string>());
  const mine = useRef(new Set<string>());
  useEffect(() => {
    const fresh = rows.filter((r) => !snapshot.current.has(r.id));
    if (!fresh.length) return;
    for (const [k, v] of snapshotOf(fresh)) snapshot.current.set(k, v);
    setChecked((cur) => new Set([...cur, ...fresh.filter((r) => r.preChecked).map((r) => r.id)]));
  }, [rows]);
  /**
   * An extras group is open (on To log the user opened it; on the Review page, always): tick its items, each once, so a
   * user never stages a use case they have not seen and an untick sticks. One that arrives later in an open group is
   * ticked by the same call.
   */
  const reveal = useCallback((items: readonly Pick<ReviewExtra, 'id' | 'preTicked' | 'locked'>[]) => {
    const fresh = items.filter((x) => !revealed.current.has(x.id));
    if (!fresh.length) return;
    for (const x of fresh) revealed.current.add(x.id);
    // a DC with light evidence or a split question is seen but not ticked (DcSuggestions' rule)
    const on = fresh.filter((x) => x.preTicked !== false && canTickExtra(x)).map((x) => x.id);
    if (on.length) setChecked((cur) => new Set([...cur, ...on]));
  }, []);

  const flip = useCallback((id: string) => {
    if (lockedRef.current.has(id)) return;
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggle = useCallback((r: ReviewEntry) => canCheck(r) && flip(r.id), [flip]);
  /** Tick (or untick) many at once: a group header. */
  const setMany = useCallback((ids: readonly string[], on: boolean) => {
    setChecked((cur) => {
      const next = new Set(cur);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  // an unsure row: pick its opp (a correction the app learns from); it is ticked once saved
  const pick = useCallback(
    async (r: ReviewEntry, oppId: string) => {
      mine.current.add(r.id);
      const ok = await one(r.entry, fixPatch(r.entry, { oppId }, taskTypeRequired));
      if (!ok) return;
      snapshot.current.set(r.id, { ...(snapshot.current.get(r.id) ?? { internal: false, version: r.entry.version, status: r.entry.status }), oppId });
      setChecked((cur) => new Set([...cur, r.id]));
    },
    [one, taskTypeRequired],
  );

  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<StageLogBatchResult | null>(null);
  const button = logButton(rows, checked, extras);

  const logThese = useCallback(async () => {
    if (button.disabled || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const ids = rows.filter((r) => checked.has(r.id) && canCheck(r)).map((r) => r.id);
      // re-check: a row that changed under me is never logged silently
      const fresh = await loadFresh();
      const changes = recheck(snapshot.current, fresh, ids, mine.current);
      if (changes.length) {
        const byId = new Map(fresh.map((e) => [e.id, e] as const));
        for (const c of changes) {
          const e = byId.get(c.id);
          if (e) snapshot.current.set(c.id, { oppId: e.oppId, internal: e.internal, version: e.version, status: e.status });
          else snapshot.current.delete(c.id);
        }
        setChecked((cur) => new Set([...cur].filter((id) => !changes.some((c) => c.id === id))));
        setNotice(changeNotice(changes));
        return;
      }
      // take the suggestions it is logging (one save each, like Accept), then stage the one batch
      for (const r of rows) {
        if (r.kind !== 'suggested' || !checked.has(r.id)) continue;
        const patch = acceptPatch(r.entry, taskTypeRequired);
        if (patch) await api('patchActivity', { params: { id: r.id }, body: { ifVersion: r.entry.version, patch } });
      }
      // the ticked DCs: each claimed (a DC request) so it rides this batch
      for (const id of dcsToClaim(extras, checked)) await api('decideDcSuggestion', { params: { id }, body: { decision: 'accept' } });
      const res = (await api('stageLogBatch', { body: stageRequest(rows, checked, extras) })).entity;
      setResult(res);
    } catch (err) {
      setNotice(`Couldn't build the batch: ${errorText(err, 200)} Nothing was sent.`);
    } finally {
      setBusy(false);
    }
  }, [button.disabled, busy, rows, checked, extras, loadFresh, taskTypeRequired]);

  /** Back from the result line to the lane. */
  const clearResult = useCallback(() => setResult(null), []);

  return { rows, extras, settle, checked, toggle, flip, setMany, reveal, pick, button, logThese, notice, busy, result, clearResult };
}
