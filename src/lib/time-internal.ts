/**
 * Internal-only activity rows (D-64) as the contract carries them: shared by both DataSources, the Time UI and the
 * Assistant, so the mock and Postgres say the same thing about the same row. Pure.
 *
 *   isInternalEntry   no opportunity, no account, no CF / CR, an internal task type (Asset Creation, Personal
 *                     Development, …): it logs with Related To empty and never asks for an opp
 *   internalPatch     what PATCH /activity/:id does to the row's other fields when it is made internal (`internal:
 *                     true`), taken back (`internal: false`), or given an opportunity while internal
 *   restoredStatus    the status a row dismissed by a rule goes back to when the rule is removed
 */
import type { ActivityEntry, ActivityLockableField, PatchActivityRequest } from '@/contract';
import { customerTypeFor, internalTypeFor, isInternalTaskType, meetingTypeOf } from '@/engines/activity/internal';

type Shape = Pick<ActivityEntry, 'oppId' | 'accountName' | 'meetingType' | 'taskType'>;
type Patch = PatchActivityRequest['patch'];

/** Internal-only work, from the row's own fields (the db adds: no WhatId, what_kind none). */
export function isInternalEntry(e: Shape): boolean {
  return !e.oppId && !e.accountName && e.meetingType === null && isInternalTaskType(e.taskType);
}

/**
 * D-103 (c): the row knows what it logs to: an opportunity, the account itself (an account with no open opportunity,
 * or one you picked), or internal work. A row without one asks "which opportunity?".
 */
export function hasTarget(e: Pick<ActivityEntry, 'oppId' | 'internal'> & { accountId?: string | null }): boolean {
  return !!e.oppId || !!e.accountId || !!e.internal;
}

/** Issues that ask for an opportunity (they go once a row is internal). */
const OPP_ISSUE = /\bopp\b|opportunit|whatid|related to/i;

export interface InternalPatchResult {
  /** Fields to set on top of the patch. */
  fields: Partial<ActivityEntry>;
  /** Fields the change locks (the user chose them): the projection never rewrites them. */
  locks: ActivityLockableField[];
}

/**
 * The fields an edit changes besides the patch, when it touches internal-ness (null: it does not):
 *   internal: true             no opp, no account, no CF / CR, an internal type (the patch's, the row's own, else what
 *                              its words say), the opp questions gone; locks opp and type
 *   internal: false, or an     a customer type for the same work (Asset Creation → Solution Creation, Travel stays,
 *   opp on an internal row     else none: you pick one), CF / CR from it; locks the type
 */
export function internalPatch(cur: ActivityEntry, patch: Patch): InternalPatchResult | null {
  if (patch.internal === true) {
    const taskType = internalTypeFor(isInternalTaskType(patch.taskType) ? patch.taskType : cur.taskType, cur.description);
    return {
      fields: { oppId: null, oppName: null, accountName: null, meetingType: null, taskType, internal: true, issues: cur.issues.filter((i) => !OPP_ISSUE.test(i)) },
      locks: ['oppId', 'taskType', 'meetingType'],
    };
  }
  const leaving = patch.internal === false || (cur.internal && !!patch.oppId);
  if (!leaving || !cur.internal) return null;
  const taskType = patch.taskType !== undefined ? patch.taskType : customerTypeFor(cur.taskType);
  return {
    fields: { taskType, meetingType: patch.meetingType !== undefined ? patch.meetingType : meetingTypeOf(taskType), internal: false },
    locks: ['taskType', 'meetingType'],
  };
}

/** The status a row a rule had dismissed goes back to (the projection settles it on its next pass). */
export function restoredStatus(e: Pick<ActivityEntry, 'end' | 'oppId' | 'taskType' | 'durationH' | 'internal' | 'accountId'>, nowIso: string, taskTypeRequired = true): 'upcoming' | 'needs_input' | 'proposed' {
  if (Date.parse(e.end) > Date.parse(nowIso)) return 'upcoming';
  if (!hasTarget(e) || (taskTypeRequired && !e.taskType) || e.durationH <= 0) return 'needs_input';
  return 'proposed';
}
