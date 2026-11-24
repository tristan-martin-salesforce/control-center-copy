/**
 * D-64: "Dismiss all from <source>" and the internal-row edit, planned once for both DataSources (the mock and
 * Postgres change the same rows the same way; each persists in its own store, in one audited change set).
 *
 *   planDismissFromSource   the rule from a row's source (one repo, unmapped Drive docs, a recurring series) and every
 *                           live row of that source (upcoming, needs input, proposed) set aside: Dismissed by your rule
 *   planRemoveRule          the rows the rule set aside, back to the status they would have (the projection settles
 *                           them on its next pass)
 *   rulesView               the stored rules, newest first, with the rows each sets aside now
 *   patchedEntry            PATCH /activity/:id on the contract row: the patch, an opp's names, internal-ness
 *                           (src/lib/time-internal.ts) and the locks the edit makes
 */
import type { ActivityEntry, ActivityLockableField, PatchActivityRequest, TimeDismissRule } from '@/contract';
import { lockableActivityFields } from '@/contract';
import { dismissRuleFlag, isRuleDismissal } from '@/engines/activity/internal';
import { internalPatch, isInternalEntry, restoredStatus } from '@/lib/time-internal';
import { invalid } from '@/server/errors';

export type StoredDismissRule = Omit<TimeDismissRule, 'rows'>;

/** The live statuses a rule sets aside (approved and later rows are yours: a rule never touches them). */
const OPEN = new Set<ActivityEntry['status']>(['upcoming', 'needs_input', 'proposed']);

const ruleRow = (e: ActivityEntry, key: string) => e.status === 'dismissed' && e.excludedReason === 'dismiss_rule' && e.dismissSource?.key === key;

export function planDismissFromSource(entries: readonly ActivityEntry[], entryId: string, nowIso: string): { rule: StoredDismissRule; changes: ActivityEntry[] } {
  const e = entries.find((x) => x.id === entryId);
  if (!e) throw invalid('Activity entry not found');
  const src = e.dismissSource;
  if (!src) throw invalid('This row has no source to dismiss all from (a repo, unmapped Drive docs or a recurring meeting): dismiss the row itself');
  const flag = dismissRuleFlag(src.label);
  const changes = entries
    .filter((x) => x.dismissSource?.key === src.key && OPEN.has(x.status) && !x.canvasDraftId)
    .map((x) => ({ ...x, status: 'dismissed' as const, excludedReason: 'dismiss_rule' as const, issues: [...x.issues.filter((i) => !isRuleDismissal([i])), flag] }));
  return { rule: { key: src.key, kind: src.kind, label: src.label, createdAt: nowIso }, changes };
}

export function planRemoveRule(entries: readonly ActivityEntry[], key: string, nowIso: string, taskTypeRequired = true): ActivityEntry[] {
  return entries
    .filter((x) => ruleRow(x, key))
    .map((x) => ({ ...x, status: restoredStatus(x, nowIso, taskTypeRequired), excludedReason: null, issues: x.issues.filter((i) => !isRuleDismissal([i])) }));
}

export function rulesView(stored: readonly StoredDismissRule[], entries: readonly ActivityEntry[]): TimeDismissRule[] {
  return [...stored]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key))
    .map((r) => ({ ...r, rows: entries.filter((x) => ruleRow(x, r.key)).length }));
}

/** The edit's fields that become locks (`status` never; `internal` is no field: its own locks come with it). */
export function patchLocks(patch: PatchActivityRequest['patch'], extra: readonly ActivityLockableField[] = []): ActivityLockableField[] {
  return [...new Set([...lockableActivityFields(Object.keys(patch).filter((k) => k !== 'internal') as ActivityLockableField[]), ...extra])];
}

/**
 * D-103 (c): a patch's `target` as the fields it stands for: `opp` is `oppId`, `internal` is `internal: true`, and
 * `account` clears the opportunity (patchedEntry sets the account). Without a target the patch is unchanged.
 */
export function targetPatch(cur: Pick<ActivityEntry, 'internal'>, patch: PatchActivityRequest['patch']): Omit<PatchActivityRequest['patch'], 'target'> {
  const { target, ...rest } = patch;
  if (!target) return rest;
  if (target.kind === 'opp') return { ...rest, oppId: target.id };
  if (target.kind === 'internal') return { ...rest, internal: true };
  return { ...rest, oppId: null, ...(cur.internal ? { internal: false } : {}) };
}

/**
 * The row after PATCH /activity/:id, before it is stored: the patch, the picked opp's names (`opp`), internal-ness and
 * the locks (old and new). `newLocks` are the ones this edit adds (the db locks those columns).
 */
export function patchedEntry(
  cur: ActivityEntry,
  patch0: PatchActivityRequest['patch'],
  opp: { name: string; accountName: string | null } | null,
  account: { id: string; name: string } | null = null,
): { next: ActivityEntry; newLocks: ActivityLockableField[] } {
  const patch = targetPatch(cur, patch0);
  const toAccount = patch0.target?.kind === 'account';
  if (toAccount && !account) throw invalid('That account is not in the app');
  const ip = internalPatch(cur, patch);
  const newLocks = patchLocks(patch, [...(ip?.locks ?? []), ...(toAccount ? (['oppId'] as const) : [])]);
  const locks = new Set(lockableActivityFields(cur.userLockedFields));
  for (const k of newLocks) locks.add(k);
  const { internal: _internal, ...fields } = patch;
  const next: ActivityEntry = {
    ...cur,
    ...fields,
    ...(opp ? { oppName: opp.name, accountName: opp.accountName ?? cur.accountName } : patch.oppId === null ? { oppName: null } : {}),
    userLockedFields: [...locks],
    issues: patch.oppId ? cur.issues.filter((i) => !/opp/i.test(i)) : cur.issues,
    ...(ip?.fields ?? {}),
    // D-66: your note is yours (locked): no longer the app's draft; an emptied one logs the CC# key alone
    ...(patch.logNote !== undefined ? { logNote: patch.logNote.replace(/\s+/g, ' ').trim(), logNoteBasis: null } : {}),
  };
  // D-103 (c): the account target: no opportunity, the account itself (its open-opp questions go)
  if (toAccount) Object.assign(next, { accountId: account!.id, accountName: account!.name, oppId: null, oppName: null, issues: cur.issues.filter((i) => !/^NEEDS WhatId|^WhatId = account fallback/i.test(i)) });
  else if (patch.oppId || patch.internal) delete next.accountId; // absent, as the db reads a row with no account target
  next.internal = isInternalEntry(next);
  return { next, newLocks };
}
