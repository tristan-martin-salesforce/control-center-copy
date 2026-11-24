/**
 * Next best actions and drafts (the Outbox).
 *
 * next_best_actions: verb → type (+ payload.verb when lossy) · title · why → rationale · status ·
 *   confidence · model · draftId → draft_id · generatedAt → ready_at · version → version (OCC) ·
 *   runId → claude_session_id when it is a session. Everything type-specific (primaryLabel, whyDetail,
 *   sources, alternatives, toolAdapterId, toolInputs, claudeLaunch, update strip, version history) rides
 *   in `payload` — the schema's jsonb for NBA arguments — so NBAs need no side-car.
 * drafts: destination → channel/action_type/target_external_id/target_thread_external_id/subject +
 *   draft_recipients · mode → delivery_mode · doc → doc_json (+ plain_text, doc_version) · status ·
 *   userTouched → edited_by_user · userLockedFields → user_locked_fields (doc_json, destination,
 *   delivery_mode) · scheduledFor · rejectedReason → reject_reason · renditions → draft_renditions ·
 *   attempts → draft_send_attempts · verification → draft_verifications.
 *   Ext: destination display fields (channelName, target, workspace, inReplyTo, names), threadContext,
 *   savedAt, attempt details.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { ActionDestination, type DispatchAttempt, type Draft, type NbaCard, type Rendition, type TipTapDoc } from '@/contract';
import { actionFamily, actionTargetId, type ActionFamily } from '@/lib/actions';
import { claudeSessions, draftRecipients, draftRenditions, drafts, draftSendAttempts, draftVerifications, nextBestActions } from '@/db/schema';

import { plainText as docPlainText } from '../../mock/render';
import { confToNum, draftStatusFromDb, modeFromDb, modeToDb, nbaStatusFromDb, numToConf, verbFromDb, verbToDb, APPROVED_DRAFT_STATUSES, type DbDraftStatus } from '../enums';
import { hashKey, uuidFor, uuidOrNull } from '../ids';
import { ext, inKeyOrder, iso, isoReq, keyOrder, same, toDate, updateRow, writeExt, type ReadCtx, type WriteCtx } from './common';

// ---------------------------------------------------------------------------
// NBA
// ---------------------------------------------------------------------------

interface NbaPayload {
  verb: NbaCard['verb'];
  primaryLabel: string;
  whyDetail: string | null;
  sources: NbaCard['sources'];
  alternatives: NbaCard['alternatives'];
  toolAdapterId: string | null;
  toolInputs: NbaCard['toolInputs'];
  /** Key order of `toolInputs` (jsonb sorts keys; the NBA card lists the inputs in this order). */
  toolInputsOrder?: string[];
  claudeLaunch: NbaCard['claudeLaunch'];
  runId: string | null;
  update: NbaCard['update'];
  versions: NbaCard['versions'];
}

/** `itemIds`: only those items' cards (and cards on no item), for a page scope (reads/scope.ts); omitted = all. */
export async function loadNbas(rc: ReadCtx, itemIds?: readonly string[]): Promise<NbaCard[]> {
  const where = itemIds ? and(eq(nextBestActions.ownerUserId, rc.userId), or(isNull(nextBestActions.workItemId), itemIds.length ? inArray(nextBestActions.workItemId, [...itemIds]) : sql`false`)) : eq(nextBestActions.ownerUserId, rc.userId);
  const rows = await rc.db.select().from(nextBestActions).where(where).orderBy(asc(nextBestActions.createdAt), asc(nextBestActions.id));
  return rows.map((r) => {
    const p = (r.payload ?? {}) as Partial<NbaPayload>;
    return {
      id: r.id,
      workItemId: r.workItemId,
      version: r.version,
      verb: p.verb ?? verbFromDb(r.type),
      primaryLabel: p.primaryLabel ?? r.title,
      confidence: numToConf(r.confidence),
      title: r.title,
      why: r.rationale ?? '',
      whyDetail: p.whyDetail ?? null,
      sources: p.sources ?? [],
      status: nbaStatusFromDb(r.status),
      draftId: r.draftId,
      alternatives: p.alternatives ?? [],
      toolAdapterId: p.toolAdapterId ?? null,
      toolInputs: inKeyOrder(p.toolInputs ?? null, p.toolInputsOrder),
      claudeLaunch: p.claudeLaunch ?? null,
      runId: p.runId ?? r.claudeSessionId ?? null,
      update: p.update ?? null,
      versions: p.versions ?? [],
      generatedAt: isoReq(r.readyAt ?? r.createdAt),
      model: r.model,
    };
  });
}

function nbaColumns(n: NbaCard, w: Pick<WriteCtx, 'userId'>, isClaudeSession: (runId: string) => boolean, emailDraft: boolean) {
  const payload: NbaPayload = {
    verb: n.verb,
    primaryLabel: n.primaryLabel,
    whyDetail: n.whyDetail,
    sources: n.sources,
    alternatives: n.alternatives,
    toolAdapterId: n.toolAdapterId,
    toolInputs: n.toolInputs,
    toolInputsOrder: keyOrder(n.toolInputs),
    claudeLaunch: n.claudeLaunch,
    runId: n.runId,
    update: n.update,
    versions: n.versions,
  };
  const tier = n.model && /opus/i.test(n.model) ? 'opus' : n.model && /haiku/i.test(n.model) ? 'haiku' : n.model && /sonnet/i.test(n.model) ? 'sonnet' : 'none';
  return {
    id: uuidFor(n.id),
    ownerUserId: w.userId,
    workItemId: uuidFor(n.workItemId),
    nbaVersion: 1,
    status: n.status,
    type: verbToDb(n.verb, emailDraft),
    title: n.title,
    rationale: n.why,
    payload: payload as unknown as Record<string, unknown>,
    confidence: confToNum(n.confidence),
    model: n.model,
    modelTier: tier as 'opus' | 'haiku' | 'sonnet' | 'none',
    inputsHash: hashKey(n.id, n.version, n.title),
    claudeSessionId: n.runId && isClaudeSession(n.runId) ? uuidFor(n.runId) : null,
    readyAt: toDate(n.generatedAt),
  };
}

/** Insert without draft_id (drafts reference NBAs and vice versa; link after both exist). */
export async function insertNba(w: WriteCtx, n: NbaCard, isClaudeSession: (runId: string) => boolean, emailDraft = false): Promise<string> {
  const cols = nbaColumns(n, w, isClaudeSession, emailDraft);
  await w.tx.insert(nextBestActions).values({ ...cols, version: n.version, createdAt: toDate(n.generatedAt)!, updatedAt: toDate(n.generatedAt)! });
  return cols.id;
}

export async function linkNbaDraft(w: WriteCtx, nbaId: string, draftId: string | null) {
  await w.tx.update(nextBestActions).set({ draftId: uuidOrNull(draftId) }).where(eq(nextBestActions.id, uuidFor(nbaId)));
}

/** NBA versions follow the contract (they are not bumped per write), so the version column is set explicitly. */
export async function updateNba(w: WriteCtx, cur: NbaCard, next: NbaCard, isClaudeSession: (runId: string) => boolean, emailDraft = false) {
  const a = nbaColumns(cur, w, isClaudeSession, emailDraft);
  const b = nbaColumns(next, w, isClaudeSession, emailDraft);
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(b) as (keyof typeof b)[]) if (k !== 'id' && k !== 'inputsHash' && !same(a[k], b[k])) patch[k] = b[k];
  if (!same(cur.draftId, next.draftId)) patch.draftId = uuidOrNull(next.draftId);
  if (next.version !== cur.version) patch.version = next.version;
  if (!Object.keys(patch).length) return;
  await w.tx.update(nextBestActions).set(patch).where(eq(nextBestActions.id, b.id));
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

interface DraftExt {
  dest: Record<string, unknown>;
  threadContext: Draft['threadContext'];
  savedAt: string;
  attemptDetail: Record<string, string>;
  attemptMode: Record<string, Draft['mode']>;
}

/** A structured action's db enums, per family (outbound_channel, draft_action_type, verification_method). */
const ACTION_DB: Record<ActionFamily, { channel: 'vdp' | 'slack_canvas' | 'slack'; actionType: 'vdp_update' | 'canvas_rewrite' | 'slack_message'; verify: 'vdp_read' | 'canvas_read' | 'slack_read' }> = {
  vdp: { channel: 'vdp', actionType: 'vdp_update', verify: 'vdp_read' },
  slack_canvas: { channel: 'slack_canvas', actionType: 'canvas_rewrite', verify: 'canvas_read' },
  // D-56: a feedback report is one Slack message (its whole report rides in the payload column, like every action)
  feedback: { channel: 'slack', actionType: 'slack_message', verify: 'slack_read' },
  // D-90: a release announcement is one Slack message too; the upload hand-off rides the same enums (it never sends)
  release: { channel: 'slack', actionType: 'slack_message', verify: 'slack_read' },
};

const LOCK_COL: Record<Draft['userLockedFields'][number], string> = { doc: 'doc_json', destination: 'destination', mode: 'delivery_mode' };
const COL_LOCK = Object.fromEntries(Object.entries(LOCK_COL).map(([f, c]) => [c, f])) as Record<string, Draft['userLockedFields'][number]>;
export const draftLockColumns = (fields: Draft['userLockedFields']) => fields.map((f) => LOCK_COL[f]);

function outcomeToStatus(o: DispatchAttempt['outcome']): 'started' | 'succeeded' | 'failed' | 'unknown' {
  return o === 'failed' ? 'failed' : o === 'unconfirmed' ? 'unknown' : 'succeeded';
}
function statusToOutcome(s: 'started' | 'succeeded' | 'failed' | 'unknown', dryRun: boolean, mode: Draft['mode']): DispatchAttempt['outcome'] {
  if (s === 'failed') return 'failed';
  if (s === 'unknown' || s === 'started') return 'unconfirmed';
  if (dryRun) return 'rendered';
  return mode === 'draft' ? 'staged' : 'sent';
}
const VERIFY: Record<NonNullable<Draft['verification']>['state'], 'pending' | 'matched' | 'not_found' | 'error'> = { pending: 'pending', verified: 'matched', unverified: 'not_found', failed: 'error' };

export async function loadDrafts(rc: ReadCtx): Promise<Draft[]> {
  const rows = await rc.db.select().from(drafts).where(eq(drafts.ownerUserId, rc.userId)).orderBy(asc(drafts.createdAt), asc(drafts.id));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const recips = await rc.db.select().from(draftRecipients).where(inArray(draftRecipients.draftId, ids)).orderBy(asc(draftRecipients.id));
  const rends = await rc.db.select().from(draftRenditions).where(inArray(draftRenditions.draftId, ids));
  const atts = await rc.db.select().from(draftSendAttempts).where(inArray(draftSendAttempts.draftId, ids)).orderBy(asc(draftSendAttempts.attemptNo));
  const vers = await rc.db.select().from(draftVerifications).where(inArray(draftVerifications.draftId, ids)).orderBy(desc(draftVerifications.id));
  return rows.map((r) => {
    const x = ext<DraftExt>(rc, 'drafts', r.id);
    const dx = (x.dest ?? {}) as Record<string, unknown>;
    const doc = (r.docJson ?? { type: 'doc', content: [] }) as TipTapDoc;
    const mine = recips.filter((p) => p.draftId === r.id);
    // A structured action keeps its whole destination (input, changes, target) in the `payload` column: its body.
    const act = (r.payload as { kind?: unknown } | null)?.kind === 'action' ? ActionDestination.safeParse(r.payload) : null;
    const destination: Draft['destination'] = act?.success
      ? act.data
      : r.channel === 'slack'
        ? {
            kind: 'slack',
            target: (dx.target as 'thread' | 'channel' | 'dm') ?? (r.targetThreadExternalId ? 'thread' : 'channel'),
            channelId: r.targetExternalId ?? '',
            channelName: (dx.channelName as string) ?? mine.find((m) => m.role === 'channel')?.displayName ?? r.targetExternalId ?? '',
            threadTs: r.targetThreadExternalId,
            ...(dx.workspace ? { workspace: dx.workspace as string } : {}),
          }
        : {
            kind: 'email',
            target: (dx.target as 'reply' | 'reply_all' | 'new' | 'forward') ?? (r.actionType === 'email_reply' ? 'reply' : 'new'),
            to: mine.filter((m) => m.role === 'to').map((m) => ({ ...(m.displayName ? { name: m.displayName } : {}), email: m.address })),
            cc: mine.filter((m) => m.role === 'cc').map((m) => ({ ...(m.displayName ? { name: m.displayName } : {}), email: m.address })),
            subject: r.subject ?? '',
            threadId: r.targetThreadExternalId,
            inReplyTo: (dx.inReplyTo as string | null) ?? null,
          };
    const order = (dx.recipientOrder as string[] | undefined) ?? [];
    if (destination.kind === 'email' && order.length) {
      const pos = (e: string) => (order.indexOf(e) === -1 ? 1e9 : order.indexOf(e));
      destination.to.sort((a, b) => pos(a.email) - pos(b.email));
      destination.cc.sort((a, b) => pos(a.email) - pos(b.email));
    }
    const rendered: Draft['rendered'] = {};
    for (const rr of rends.filter((x2) => x2.draftId === r.id && x2.docVersion === r.docVersion)) {
      if (rr.format === 'slack_mrkdwn') rendered.slack_mrkdwn = { format: 'slack_mrkdwn', body: rr.body, text: rr.body, lossy: rr.warnings };
      if (rr.format === 'email_html') rendered.email_html = { format: 'email_html', body: rr.body, text: r.plainText ?? docPlainText(doc), lossy: rr.warnings };
      if (rr.format === 'plain_text') rendered.plain_text = { format: 'plain_text', body: rr.body, text: rr.body, lossy: rr.warnings };
    }
    const mode = modeFromDb(r.deliveryMode);
    const v = vers.find((x2) => x2.draftId === r.id);
    const attempts: DispatchAttempt[] = atts
      .filter((a) => a.draftId === r.id)
      .map((a) => {
        const aid = String(a.id);
        const am = x.attemptMode?.[aid] ?? (a.adapter.endsWith(':send') ? 'send' : 'draft');
        return {
          id: aid,
          at: isoReq(a.startedAt),
          mode: am,
          dryRun: a.dryRun,
          outcome: statusToOutcome(a.status, a.dryRun, am),
          ...(x.attemptDetail?.[aid] ? { detail: x.attemptDetail[aid] } : a.errorMessage ? { detail: a.errorMessage } : {}),
        };
      });
    return {
      id: r.id,
      version: r.version,
      workItemId: r.workItemId,
      nbaId: r.nbaId,
      destination,
      mode,
      doc,
      plainText: r.plainText ?? '',
      rendered,
      userTouched: r.editedByUser,
      userLockedFields: r.userLockedFields.map((c) => COL_LOCK[c]).filter((f): f is Draft['userLockedFields'][number] => !!f),
      status: draftStatusFromDb(r.status),
      threadContext: x.threadContext ?? [],
      createdAt: isoReq(r.createdAt),
      updatedAt: isoReq(r.updatedAt),
      savedAt: x.savedAt ?? null,
      scheduledFor: iso(r.scheduledFor),
      attempts,
      verification: v ? { state: v.status === 'matched' ? 'verified' : v.status === 'not_found' ? 'unverified' : v.status === 'pending' ? 'pending' : 'failed', at: iso(v.checkedAt), detail: v.diffSummary ?? '' } : null,
      rejectedReason: r.rejectReason,
      resultUrl: r.resultUrl,
      // D-60: who approved it to leave (VDP autopilot's autonomy policy, or the user)
      ...(r.approvalMethod === 'autonomy_policy' ? { appliedBy: 'autopilot' as const } : {}),
      // D-63: what a VDP create returned (its new id), for the items a chained push applies under it
      ...(r.sentExternalId ? { externalId: r.sentExternalId } : {}),
    };
  });
}

function draftColumns(d: Draft, w: Pick<WriteCtx, 'userId'>) {
  const dest = d.destination;
  const status = d.status as DbDraftStatus;
  const needsApproval = APPROVED_DRAFT_STATUSES.has(status);
  return {
    id: uuidFor(d.id),
    ownerUserId: w.userId,
    workItemId: uuidOrNull(d.workItemId),
    nbaId: uuidOrNull(d.nbaId),
    actionType: dest.kind === 'slack' ? (dest.target === 'thread' ? 'slack_reply' : 'slack_message') : dest.kind === 'action' ? ACTION_DB[actionFamily(dest.action)].actionType : dest.target === 'new' ? 'email_message' : 'email_reply',
    channel: dest.kind === 'slack' ? 'slack' : dest.kind === 'action' ? ACTION_DB[actionFamily(dest.action)].channel : 'email',
    deliveryMode: modeToDb(d.mode),
    status,
    docJson: d.doc as unknown as Record<string, unknown>,
    plainText: d.plainText,
    contentHash: hashKey(d.doc),
    targetExternalId: dest.kind === 'slack' ? dest.channelId : dest.kind === 'action' ? actionTargetId(dest) : (dest.to[0]?.email ?? null),
    targetThreadExternalId: dest.kind === 'slack' ? dest.threadTs : dest.kind === 'action' ? null : dest.threadId,
    subject: dest.kind === 'email' ? dest.subject : null,
    // The structured body of a non-message action (schema: "VDP patch, Org62 rows, calendar hold"): its destination.
    payload: dest.kind === 'action' ? (dest as unknown as Record<string, unknown>) : null,
    scheduledFor: toDate(d.scheduledFor),
    approvedAt: needsApproval ? toDate(d.updatedAt) : null,
    approvalMethod: needsApproval ? ('click' as const) : null,
    rejectedAt: d.status === 'rejected' ? toDate(d.updatedAt) : null,
    rejectReason: d.rejectedReason,
    resultUrl: d.resultUrl ?? null,
    editedByUser: d.userTouched,
  } as const;
}

function draftExt(d: Draft, attemptIds: string[]): Record<string, unknown> {
  const dest = d.destination;
  const destExt =
    dest.kind === 'slack'
      ? { target: dest.target, channelName: dest.channelName, workspace: dest.workspace }
      : dest.kind === 'action'
        ? {}
        : { target: dest.target, inReplyTo: dest.inReplyTo, recipientOrder: [...dest.to, ...dest.cc].map((a) => a.email) };
  const detail: Record<string, string> = {};
  const modes: Record<string, Draft['mode']> = {};
  d.attempts.forEach((a, i) => {
    const id = attemptIds[i] ?? a.id;
    if (a.detail) detail[id] = a.detail;
    modes[id] = a.mode;
  });
  return { dest: destExt, threadContext: d.threadContext, savedAt: d.savedAt ?? undefined, attemptDetail: Object.keys(detail).length ? detail : undefined, attemptMode: Object.keys(modes).length ? modes : undefined };
}

async function writeRecipients(w: WriteCtx, d: Draft, replace: boolean) {
  const id = uuidFor(d.id);
  if (replace) await w.tx.delete(draftRecipients).where(eq(draftRecipients.draftId, id));
  const dest = d.destination;
  const rows =
    dest.kind === 'slack'
      ? [{ draftId: id, role: 'channel' as const, address: dest.channelId, displayName: dest.channelName }]
      : dest.kind === 'action'
        ? []
        : [...dest.to.map((a) => ({ draftId: id, role: 'to' as const, address: a.email, displayName: a.name ?? null })), ...dest.cc.map((a) => ({ draftId: id, role: 'cc' as const, address: a.email, displayName: a.name ?? null }))];
  if (rows.length) await w.tx.insert(draftRecipients).values(rows).onConflictDoNothing();
}

async function writeRenditions(w: WriteCtx, draftId: string, docVersion: number, rendered: Draft['rendered']) {
  const rows = (['slack_mrkdwn', 'email_html', 'plain_text'] as const)
    .map((f) => rendered[f])
    .filter((r): r is Rendition => !!r)
    .map((r) => ({ draftId, docVersion, format: r.format, body: r.body, rendererVersion: 'cc-render@1', contentHash: hashKey(r.body), lossy: r.lossy.length > 0, warnings: r.lossy }));
  if (rows.length) await w.tx.insert(draftRenditions).values(rows).onConflictDoNothing();
}

async function writeAttempts(w: WriteCtx, d: Draft, existing: DispatchAttempt[]): Promise<string[]> {
  const id = uuidFor(d.id);
  const ids: string[] = existing.map((a) => a.id);
  for (let i = existing.length; i < d.attempts.length; i++) {
    const a = d.attempts[i]!;
    const explicit = /^\d+$/.test(a.id) ? Number(a.id) : undefined;
    const [row] = await w.tx
      .insert(draftSendAttempts)
      .values({
        ...(explicit ? { id: explicit } : {}),
        draftId: id,
        attemptNo: i + 1,
        dryRun: a.dryRun,
        adapter: `${d.destination.kind}:${a.mode}`,
        requestHash: hashKey(d.id, d.version, a.mode),
        status: outcomeToStatus(a.outcome),
        startedAt: toDate(a.at)!,
        finishedAt: a.outcome === 'unconfirmed' ? null : toDate(a.at),
      })
      .returning({ id: draftSendAttempts.id });
    ids.push(String(row!.id));
  }
  return ids;
}

async function writeVerification(w: WriteCtx, d: Draft) {
  if (!d.verification) return;
  await w.tx.insert(draftVerifications).values({
    draftId: uuidFor(d.id),
    method: d.destination.kind === 'slack' ? 'slack_read' : d.destination.kind === 'action' ? ACTION_DB[actionFamily(d.destination.action)].verify : 'gmail_read',
    status: VERIFY[d.verification.state],
    diffSummary: d.verification.detail,
    checkedAt: toDate(d.verification.at),
  });
}

export async function insertDraft(w: WriteCtx, d: Draft): Promise<string> {
  const cols = draftColumns(d, w);
  await w.tx.insert(drafts).values({
    ...cols,
    idempotencyKey: `cc:draft:${cols.id}`,
    createdBy: 'engine',
    docVersion: 1,
    userLockedFields: draftLockColumns(d.userLockedFields).sort(),
    version: d.version,
    createdAt: toDate(d.createdAt)!,
    updatedAt: toDate(d.updatedAt)!,
  });
  await writeRecipients(w, d, false);
  await writeRenditions(w, cols.id, 1, d.rendered);
  const attemptIds = await writeAttempts(w, d, []);
  await writeVerification(w, d);
  await writeExt(w, 'drafts', cols.id, draftExt(d, attemptIds));
  return cols.id;
}

export interface DraftUpdateOpts {
  bump: boolean;
  ifVersion?: number;
  lock?: Draft['userLockedFields'];
  /** Engine write that must become a proposal when the user touched the draft. */
  lockAll?: boolean;
}

export async function updateDraft(w: WriteCtx, cur: Draft, next: Draft, o: DraftUpdateOpts): Promise<{ attemptIds: string[]; proposals: { field: string; proposalId: string }[] }> {
  const a = draftColumns(cur, w);
  const b = draftColumns(next, w);
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(b) as (keyof typeof b)[]) if (k !== 'id' && k !== 'ownerUserId' && !same(a[k], b[k])) patch[k] = b[k];
  const docChanged = !same(cur.doc, next.doc);
  if (docChanged) patch.docVersion = sql`${drafts.docVersion} + 1`;
  const r = await updateRow(w, drafts, b.id, patch, {
    bump: o.bump,
    ifVersion: o.ifVersion,
    lock: o.lock ? draftLockColumns(o.lock) : false,
    extChanged: true,
    stampUpdatedAt: o.bump || !same(cur.updatedAt, next.updatedAt),
  });
  if (docChanged || !same(cur.rendered, next.rendered)) {
    const [row] = await w.tx.select({ v: drafts.docVersion }).from(drafts).where(eq(drafts.id, b.id));
    await writeRenditions(w, b.id, row!.v, next.rendered);
  }
  if (!same(cur.destination, next.destination)) await writeRecipients(w, next, true);
  const attemptIds = await writeAttempts(w, next, cur.attempts);
  if (!same(cur.verification, next.verification)) await writeVerification(w, next);
  const prevExt = (w.kv.get(`cc.ext/drafts/${b.id}`) as Partial<DraftExt> | undefined) ?? {};
  const nx = draftExt(next, attemptIds);
  nx.attemptDetail = { ...(prevExt.attemptDetail ?? {}), ...((nx.attemptDetail as Record<string, string>) ?? {}) };
  nx.attemptMode = { ...(prevExt.attemptMode ?? {}), ...((nx.attemptMode as Record<string, string>) ?? {}) };
  await writeExt(w, 'drafts', b.id, nx);
  return { attemptIds, proposals: r.proposals };
}

/** Engine revision of a draft body: locked (user-touched) drafts get a doc_json proposal instead. */
export async function engineDraftDoc(w: WriteCtx, d: Draft, doc: TipTapDoc, reason: string): Promise<{ proposalIds: string[] }> {
  const res = await w.cs.update(drafts, uuidFor(d.id), { docJson: doc as unknown as Record<string, unknown> }, { lockAll: true, reason });
  return { proposalIds: res.proposals.map((p) => p.proposalId) };
}

export async function sessionIds(w: Pick<WriteCtx, 'tx' | 'userId'>): Promise<Set<string>> {
  const rows = await w.tx.select({ id: claudeSessions.id }).from(claudeSessions).where(and(eq(claudeSessions.ownerUserId, w.userId)));
  return new Set(rows.map((r) => r.id));
}
