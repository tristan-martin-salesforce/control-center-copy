'use client';
/**
 * The pickers of the compact row being edited (CompactActivityRow's `editor`): opportunity, task type (when the
 * persona needs one or the row has one) and hours, each saving on its own like Needs you's fields. Mounted only on the
 * row being edited; Esc (the kit's editor cell) ends the edit.
 */
import type { ActivityEntry } from '@/contract';
import { HoursField, OppField, TaskTypeField, useRowSave, type Pickers } from './RowParts';

export function CompactEditor({ e, pick }: { e: ActivityEntry; pick: Pickers }) {
  const save = useRowSave(e, pick.taskTypeRequired);
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <OppField e={e} pick={pick} save={save} className="min-h-8 flex-1" />
        {/* D-103 (c): why it logs there (the facts, one sentence) */}
        {e.groundwork ? (
          <span className="truncate text-caption text-muted" data-testid="row-groundwork" title={e.groundwork.text}>
            {e.groundwork.text}
          </span>
        ) : null}
      </span>
      {pick.taskTypeRequired || e.taskType ? <TaskTypeField e={e} pick={pick} onSave={(t) => save({ taskType: t })} className="h-8 w-36 shrink-0" /> : null}
      <span className="w-16 shrink-0">
        <HoursField e={e} onSave={(h) => save({ durationH: h })} className="h-8" />
      </span>
    </>
  );
}
