'use client';
/**
 * Activity-log table (UI-SPEC §8, §12): one `ActivityRow` per entry, autosaved per row, grouped by day.
 * Edits are optimistic (cache patched first), debounced 1 s / saved on blur, and a failure rolls the row back and
 * shows "Couldn't save · Retry" in the row's status slot; a 409 offers Keep mine / Take theirs. Read-back state
 * (unconfirmed / missing in Org62) is derived and shown in the status cell.
 *
 * Design v2: a click outside the fields (or Enter on the row) selects the row and opens it in the docked panel
 * (kind 'activity_entry'); j/k move the selection. Rows wrap to the list's width (docs/archive/2026-build/time-redesign.md): no
 * sideways scroll, no cut-off column.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ActivityEntry } from '@/contract';
import { ActivityRow, type ActivityPatch } from '@/components/domain';
import { dayLabel } from '@/components/domain/lib/time';
import { usePromptWording } from '@/components/domain/ResultLinks';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { useAutosave } from '@/client/save';
import { InlineStatus } from '@/ui';
import { overlapCaption, READBACK_LABEL, readbackState } from './derive';
import { OppPicker } from './OppPicker';


interface Edit {
  seq: number;
  patch: ActivityPatch;
}
const EDIT_EQ = (a: Edit, b: Edit) => a.seq === b.seq;

/** A day's hours; where accepted meetings or an onsite day overlap (both log, D-18 amended), by how much. */
function DayTotal({ rows }: { rows: ActivityEntry[] }) {
  const caption = overlapCaption(rows);
  return (
    <span className="ml-auto text-caption text-muted tabular-nums" data-testid="day-total">
      {Math.round(rows.reduce((s, r) => s + r.durationH, 0) * 100) / 100} h{caption ? ` · ${caption}` : ''}
    </span>
  );
}

/** One autosaving log row (the week table and the Log view's editable rows). */
export function AutosaveRow({ entry, now, highlight, selected, onSelect }: { entry: ActivityEntry; now: string; highlight: boolean; selected: boolean; onSelect: (e: ActivityEntry) => void }) {
  const params = useSearchParams();
  const wording = usePromptWording();
  const forceFail = params.get('fail') === '1';
  const [edit, setEdit] = useState<Edit>({ seq: 0, patch: {} });
  const [resetKey, setResetKey] = useState(0);
  // a picked opp shows its name and account at once (the patch itself carries only the id)
  const oppShown = useRef<{ oppId: string | null; oppName: string | null; accountName: string | null } | null>(null);
  const flushNext = useRef(false);
  const m = useOptimisticMutation({
    route: 'patchActivity',
    topics: ['time'],
    fail: forceFail,
    // Only the user's own fields are in the patch; a stale version re-sends on the new one when nothing overlaps.
    optimistic: (input, cache) =>
      cache.patchEntity(entry.id, (e) => {
        const p = (input.body?.patch ?? {}) as ActivityPatch;
        const shown = 'oppId' in p && oppShown.current && oppShown.current.oppId === p.oppId ? { oppName: oppShown.current.oppName, accountName: oppShown.current.accountName ?? e.accountName } : {};
        return { ...e, ...p, ...shown };
      }),
    onError: () => setResetKey((k) => k + 1), // remount so locally typed text snaps back to the rolled-back value
  });
  const autosave = useAutosave<Edit>(
    edit,
    async (v) => {
      await m.mutateAsync({ params: { id: entry.id }, body: { ifVersion: m.versionOf(entry.id) ?? entry.version, patch: v.patch as never } });
      setEdit((cur) => (cur.seq === v.seq ? { seq: cur.seq, patch: {} } : cur));
    },
    { isEqual: EDIT_EQ },
  );
  const onChange = useCallback((p: ActivityPatch) => setEdit((cur) => ({ seq: cur.seq + 1, patch: { ...cur.patch, ...p } })), []);
  // a pick from the opportunity picker saves now, not after the typing debounce
  useEffect(() => {
    if (!flushNext.current) return;
    flushNext.current = false;
    void autosave.flush();
  }, [edit, autosave]);
  const pickOpp = useCallback(
    (oppId: string | null, shown: { oppName: string | null; accountName: string | null }) => {
      oppShown.current = { oppId, ...shown };
      flushNext.current = true;
      onChange({ oppId });
    },
    [onChange],
  );
  // D-64: "Internal (no opportunity)": the server sets the internal type and clears the opp; saved now
  const pickInternal = useCallback(() => {
    oppShown.current = null;
    flushNext.current = true;
    onChange({ internal: true, oppId: null });
  }, [onChange]);

  const rb = readbackState(entry, now);
  const shown = useMemo<ActivityEntry>(() => (rb ? { ...entry, issues: [READBACK_LABEL[rb], ...entry.issues] } : entry), [entry, rb]);
  const status = m.status === 'conflict' ? { ...autosave.status, state: 'conflict' as const } : autosave.status;

  return (
    <div data-activity-id={entry.id} data-row-id={entry.id} data-selected={selected ? '' : undefined} onBlurCapture={() => void autosave.flush()} className="min-w-0">
      <ActivityRow
        key={`${entry.id}:${resetKey}`}
        entry={shown}
        selected={selected}
        highlight={highlight}
        onOpen={() => onSelect(entry)}
        // the persona's task types (the SE's: the SE Task Type taxonomy); the row keeps its own value too
        taskTypes={wording.taskTypes}
        taskTypeRequired={wording.taskType}
        oppField={(p) => <OppPicker entry={shown} disabled={p.disabled} className={p.className} onPick={pickOpp} onInternal={wording.internal ? pickInternal : undefined} />}
        onChange={onChange}
        statusSlot={
          m.conflict ? (
            <span className="inline-flex gap-1">
              <button type="button" className="font-bold text-link hover:underline" onClick={m.conflict.keepMine}>
                Keep mine
              </button>
              <button type="button" className="text-link hover:underline" onClick={m.conflict.takeTheirs}>
                Take theirs
              </button>
            </span>
          ) : (
            <InlineStatus {...status} />
          )
        }
      />
    </div>
  );
}

export interface ActivityTableProps {
  entries: ActivityEntry[];
  now: string;
  tz?: string;
  highlightId?: string | null;
  selectedId?: string | null;
  /** Row click outside the fields, or Enter: select it and open Details. */
  onSelect?: (e: ActivityEntry) => void;
  /** Focused row (chat context). */
  onFocusEntry?: (e: ActivityEntry | null) => void;
}

export function ActivityTable({ entries, now, highlightId, selectedId, onSelect, onFocusEntry }: ActivityTableProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => {
    const sorted = [...entries].filter((e) => e.status !== 'dismissed').sort((a, b) => a.start.localeCompare(b.start));
    const out: Array<{ date: string; rows: ActivityEntry[] }> = [];
    for (const e of sorted) {
      const g = out[out.length - 1];
      if (g && g.date === e.date) g.rows.push(e);
      else out.push({ date: e.date, rows: [e] });
    }
    return out;
  }, [entries]);

  return (
    <div
      ref={rootRef}
      className="min-w-0"
      onFocusCapture={(ev) => {
        const id = (ev.target as HTMLElement).closest('[data-activity-id]')?.getAttribute('data-activity-id');
        if (id) onFocusEntry?.(entries.find((e) => e.id === id) ?? null);
      }}
    >
      {/* each row is a kit ActionRow (the fields as its trailing controls, the day and description as its expansion) */}
      <div role="grid" aria-label="Activity log" className="min-w-0 px-1">
        {groups.map((g) => (
          <div key={g.date} role="rowgroup" aria-label={dayLabel(`${g.date}T12:00:00Z`, 'UTC')}>
            {/* a light day line: the day, its rows and hours; no box */}
            <div className="flex min-h-9 items-baseline gap-2 px-4 pt-3 pb-1">
              <span className="text-body font-bold text-fg-heading">{dayLabel(`${g.date}T12:00:00Z`, 'UTC')}</span>
              <span className="text-caption text-muted tabular-nums">{g.rows.length === 1 ? '1 row' : `${g.rows.length} rows`}</span>
              <DayTotal rows={g.rows.filter((r) => r.status !== 'upcoming')} />
            </div>
            {g.rows.map((e) => (
              <AutosaveRow key={e.id} entry={e} now={now} highlight={highlightId === e.id} selected={selectedId === e.id} onSelect={(x) => onSelect?.(x)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
