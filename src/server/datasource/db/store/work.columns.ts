// Work item lock columns and field/column maps. Split from work.ts (max-lines); work.ts re-exports the public names.
import type { WorkItemLockableField } from '@/contract';

// ---------------------------------------------------------------------------
// Lockable fields: contract name ↔ column name(s)
// ---------------------------------------------------------------------------

export const WORK_LOCK_COLUMNS: Record<WorkItemLockableField, string[]> = {
  title: ['title'],
  purpose: ['purpose'],
  due: ['due_at'],
  startBy: ['start_by'], // ext-backed (no column): a pseudo lock name
  effort: ['effort_minutes', 'lead_time_minutes'],
  notes: ['description'],
  initiativeId: ['initiative_id'],
  accountId: ['account_id'],
  oppId: ['opportunity_id'],
  state: ['status'],
  kind: ['kind'],
};
const COLUMN_LOCK = new Map<string, WorkItemLockableField>();
for (const [f, cs] of Object.entries(WORK_LOCK_COLUMNS)) for (const c of cs) COLUMN_LOCK.set(c, f as WorkItemLockableField);
export const lockColumns = (fields: WorkItemLockableField[]) => [...new Set(fields.flatMap((f) => WORK_LOCK_COLUMNS[f]))];
export function lockFieldsFromColumns(cols: string[]): WorkItemLockableField[] {
  const out: WorkItemLockableField[] = [];
  for (const c of cols) {
    const f = COLUMN_LOCK.get(c);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}
/** Contract field → column, for proposals (change_proposals.field holds column names). */
export const WORK_FIELD_COLUMN: Record<string, string> = {
  title: 'title',
  purpose: 'purpose',
  due: 'due_at',
  notes: 'description',
  initiativeId: 'initiative_id',
  accountId: 'account_id',
  oppId: 'opportunity_id',
  state: 'status',
  kind: 'kind',
  servesEventId: 'deadline_event_id',
};
export const COLUMN_FIELD = Object.fromEntries(Object.entries(WORK_FIELD_COLUMN).map(([f, c]) => [c, f]));
/**
 * work_item_training_details (and work_item_travel_details) key on work_item_id and have no `id` column.
 * Migration 0005 (INTEGRATE-1, BE-1b blocker B1) keys their audit rows by that column, so the training view
 * lives in the real table again: course, provider (enum; the display string stays in ext when lossy), url,
 * required-by date, minutes, mandatory. Only `overdue` (a derived flag) stays in ext. Older rows written
 * while the table was unwritable still read from ext (`training`).
 */
export const TRAINING_DETAILS_WRITABLE = true;
