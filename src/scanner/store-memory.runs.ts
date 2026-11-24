// InMemoryScannerStore run writes. Split from store-memory.ts (max-lines); the class is still exported from store-memory.ts.
import { deliveryMatch } from './delivery';
import { personaOf } from '../personas';
import type { ResolvedPersona } from '../personas/types';
import {
  type Candidate, type ConnectorHealthProbe, type Confidence, type CoverageObject, type Cursor, type EvidenceRole,
  type NormalizedSourceItem, type ProposeItemInput, type ScanRunStats, type ScanTrigger, type ScopeKey,
  type TimeWindow, scopeId,
} from './types';
import type { BriefHighlightsInput, CandidateExt } from './runtime/contract-ext';
import { pastDueOnArrival, pastDueReason, staleOnArrival, stillNeededReason } from '@/engines/still-needed';
import { counterpartNames, nameWords, parseDue, sameDeliverable } from './propose-rules';
import {
  toMs, tokenize, normPerson, normDriveRef, type SourceItemRow, NotFoundError, type WorkItemRow,
  type UnlinkedRow, CoverageError, clampToCursor, mergeRanges, rangeOf, isRange, firstHole, iso, rangeFields,
  RunStateError,
} from './store-memory.rows';
import { InMemoryScannerStoreState } from './store-memory.state';

/** InMemoryScannerStore's run writes: persona, source items, candidates, evidence, proposals, coverage, finish / fail. */
export abstract class InMemoryScannerStoreRuns extends InMemoryScannerStoreState {

  /** D-55: the persona (absent in the profile: the SE persona). */
  async persona(): Promise<ResolvedPersona> {
    return this.profile.persona ?? personaOf({});
  }

  /** Tests: switch the persona (the runtime picks it up on its next plan pass). */
  setPersona(p: ResolvedPersona | undefined): void {
    this.profile = { ...this.profile, persona: p };
  }

  async startRun(input: { scope: ScopeKey; trigger: ScanTrigger; window: TimeWindow; model?: string; skillVersion?: string }): Promise<{ runId: string }> {
    const sid = scopeId(input.scope);
    if (toMs(input.window.from) == null || toMs(input.window.to) == null) throw new RangeError('startRun: invalid window');
    const id = this.id('run');
    this.runs.set(id, {
      id,
      scope: input.scope,
      scopeId: sid,
      trigger: input.trigger,
      window: { ...input.window },
      model: input.model,
      skillVersion: input.skillVersion,
      status: 'running',
      startedAt: this.nowIso(),
      cursorBefore: this.cursors.get(sid) ?? null,
      staged: [],
      flagged: new Set(),
      seen: new Map(),
    });
    return { runId: id };
  }

  async recordSourceItems(runId: string, items: NormalizedSourceItem[]) {
    const run = this.mustRunning(runId);
    const out: Array<{ sourceItemId: string; dedupeKey: string; isNew: boolean; changed: boolean }> = [];
    for (const raw of items) {
      if (!raw.dedupeKey || !raw.contentHash || !raw.externalId) throw new RangeError('recordSourceItems: dedupeKey, contentHash and externalId are required');
      const watchOk = run.scope.connector === 'watch' && (raw.connector === 'slack' || raw.connector === 'org62');
      if (raw.connector !== run.scope.connector && !watchOk) throw new RangeError(`recordSourceItems: item connector ${raw.connector} ≠ run connector ${run.scope.connector}`);
      const item = { ...raw, excerpt: raw.excerpt && raw.excerpt.length > 4000 ? raw.excerpt.slice(0, 4000) : raw.excerpt }; // R6
      const existingId = this.byDedupe.get(item.dedupeKey);
      if (!existingId) {
        const id = this.id('si');
        this.sourceItems.set(id, { ...item, id, revision: 1, firstRunId: runId, lastRunId: runId });
        this.byDedupe.set(item.dedupeKey, id);
        run.seen.set(item.dedupeKey, 'new');
        out.push({ sourceItemId: id, dedupeKey: item.dedupeKey, isNew: true, changed: false });
        continue;
      }
      const prev = this.sourceItems.get(existingId)!;
      if (prev.contentHash !== item.contentHash) {
        this.sourceItems.set(existingId, { ...prev, ...item, id: existingId, revision: prev.revision + 1, firstRunId: prev.firstRunId, lastRunId: runId });
        this.verdicts.delete(existingId); // an edited message is judged again
        run.seen.set(item.dedupeKey, 'changed');
        out.push({ sourceItemId: existingId, dedupeKey: item.dedupeKey, isNew: false, changed: true });
      } else {
        prev.lastRunId = runId;
        if (!run.seen.has(item.dedupeKey)) run.seen.set(item.dedupeKey, 'unchanged');
        out.push({ sourceItemId: existingId, dedupeKey: item.dedupeKey, isNew: false, changed: false });
      }
    }
    return out;
  }

  async findCandidates(q: { text?: string; people?: string[]; accounts?: string[]; threadRefs?: string[]; fileRefs?: string[]; limit?: number }): Promise<Candidate[]> {
    const now = this.clock.now().getTime();
    const tokens = new Set(tokenize(q.text));
    const people = new Set((q.people ?? []).map(normPerson).filter(Boolean));
    const accounts = new Set(this.resolveAccounts(q.accounts ?? []));
    const threads = new Set(q.threadRefs ?? []);
    const files = new Set((q.fileRefs ?? []).map(normDriveRef));
    const out: CandidateExt[] = [];
    const launched = new Set([...threads].filter((t) => t.startsWith('cc:')).map((t) => t.slice(3)));

    for (const w of this.workItems.values()) {
      if (!this.isLinkable(w, now)) continue;
      if (launched.has(w.id)) {
        out.push({ workItemId: w.id, initiativeId: w.initiativeId, title: w.title, score: 1, why: 'same thread; launched from this item', state: w.state, ...(w.resolution ? { resolution: w.resolution } : {}), ...(w.involvement ? { involvement: w.involvement } : {}) });
        continue;
      }
      let score = 0;
      const why: string[] = [];
      if ([...threads].some((t) => w.threadRefs.has(t))) {
        score += 0.6;
        why.push('same thread');
      }
      if ([...files].some((f) => w.fileRefs.has(f) || [...w.fileRefs].some((x) => normDriveRef(x) === f))) {
        score += 0.5;
        why.push('same file');
      }
      const pHits = [...people].filter((p) => [...w.people].some((wp) => wp === p || wp.includes(p) || p.includes(wp)));
      if (pHits.length) {
        score += Math.min(0.3, 0.15 * pHits.length);
        why.push(`people: ${pHits.slice(0, 3).join(', ')}`);
      }
      const aHits = [...accounts].filter((a) => w.accounts.has(a));
      if (aHits.length) {
        score += 0.25;
        why.push(`account: ${aHits[0]}`);
      }
      const itemTokens = new Set([...w.keywords, ...tokenize(w.title), ...tokenize(w.purpose)]);
      const kHits = [...tokens].filter((t) => itemTokens.has(t));
      if (kHits.length) {
        score += Math.min(0.35, (0.35 * kHits.length) / Math.max(2, Math.min(tokens.size, itemTokens.size)));
        why.push(`keywords: ${kHits.slice(0, 4).join(', ')}`);
      }
      if (score >= 0.15) {
        out.push({
          workItemId: w.id,
          initiativeId: w.initiativeId,
          title: w.title,
          score: Math.min(1, Math.round(score * 100) / 100),
          why: why.join('; '),
          state: w.state,
          ...(w.resolution ? { resolution: w.resolution } : {}),
          ...(w.involvement ? { involvement: w.involvement } : {}),
        });
      }
    }
    for (const i of this.initiatives.values()) {
      let score = 0;
      const why: string[] = [];
      const aHits = [...accounts].filter((a) => i.accounts.includes(a));
      if (aHits.length) {
        score += 0.3;
        why.push(`account: ${aHits[0]}`);
      }
      const it = new Set([...i.keywords, ...tokenize(i.title), ...tokenize(i.purpose)]);
      const kHits = [...tokens].filter((t) => it.has(t));
      if (kHits.length) {
        score += Math.min(0.4, (0.4 * kHits.length) / Math.max(2, Math.min(tokens.size, it.size)));
        why.push(`keywords: ${kHits.slice(0, 4).join(', ')}`);
      }
      if (score >= 0.2) out.push({ initiativeId: i.id, title: i.title, score: Math.min(1, Math.round(score * 100) / 100), why: why.join('; ') });
    }
    return out.sort((a, b) => b.score - a.score || (a.workItemId ?? a.initiativeId ?? '').localeCompare(b.workItemId ?? b.initiativeId ?? '')).slice(0, q.limit ?? 5);
  }

  async linkEvidence(runId: string, input: { workItemId: string; sourceItemId: string; role: EvidenceRole; confidence: Confidence; reason: string }) {
    const run = this.mustRunning(runId);
    const w = this.mustWork(input.workItemId);
    const s = this.mustSource(input.sourceItemId);
    let { confidence, reason } = input;
    // DLV-1 (as the db store): my reply in the ask's own conversation, after it, carrying what was asked → Sure.
    if (input.role === 'completion' && confidence !== 'sure' && s.connector === 'slack' && s.author?.isMe) {
      const origins = this.evidenceFor(w.id).filter((e) => e.role === 'origin').map((e) => this.sourceItems.get(e.sourceItemId)).filter((o): o is SourceItemRow => !!o && o.connector === 'slack');
      const p = (s.payload ?? {}) as { channelId?: string; channelType?: string; files?: { name?: string; mimetype?: string }[]; hasFile?: boolean };
      const same = origins.some((o) => Date.parse(o.occurredAt) < Date.parse(s.occurredAt) && (o.threadRef === s.threadRef || ((o.payload as { channelId?: string } | undefined)?.channelId === p.channelId && (p.channelType === 'im' || p.channelType === 'mpim'))));
      const urls = [...(s.excerpt ?? '').matchAll(/https?:\/\/[^\s|>)]+/g)].map((x) => x[0]);
      const what = same ? deliveryMatch({ title: w.title, purpose: w.purpose }, { files: p.files, hasFile: p.hasFile === true, urls }) : null;
      if (what) {
        confidence = 'sure';
        reason = `delivered_with_attachment: ${what}; ${reason}`;
      }
    }
    const created = this.addEvidence(run, w, s, input.role, confidence, reason);
    return { evidenceId: created.id, touchedWorkItemId: w.id };
  }

  async proposeItem(runId: string, input: ProposeItemInput) {
    const run = this.mustRunning(runId);
    if (!input.evidence.length) throw new RangeError('proposeItem: at least one evidence row is required');
    const sources = input.evidence.map((e) => this.mustSource(e.sourceItemId));
    const origins = input.evidence.filter((e) => e.role === 'origin').map((e) => e.sourceItemId);
    const keyIds = (origins.length ? origins : input.evidence.map((e) => e.sourceItemId)).slice().sort();
    const originKey = `${input.kind}|${keyIds.join(',')}`;
    const existing = this.byOriginKey.get(originKey);
    if (existing) {
      const w = this.workItems.get(existing)!;
      input.evidence.forEach((e, i) => this.addEvidence(run, w, sources[i]!, e.role, input.confidence, e.reason));
      return { workItemId: w.id, landedAs: w.landedAs };
    }
    if (input.initiativeId && !this.initiatives.has(input.initiativeId)) throw new NotFoundError(`initiative ${input.initiativeId}`);
    // DUP-1 (as the db store): same conversation, same person, same deliverable → the item already there.
    // R2 (as the db store): the asker writing to me again after a close for you reopens it (contradiction, follow_up:).
    const found = this.conversationDuplicate(origins, input.title);
    if (found) {
      const { item: dup, followUpBy } = found;
      const closed = ['done', 'dismissed', 'merged'].includes(dup.state);
      input.evidence.forEach((e, i) => {
        const followUp = !!followUpBy && e.role === 'origin';
        this.addEvidence(run, dup, sources[i]!, followUp ? 'contradiction' : closed ? 'context' : e.role, input.confidence, followUp ? `follow_up: ${followUpBy} wrote again: ${e.reason}` : `duplicate_of_existing: ${e.reason}`);
      });
      return { workItemId: dup.id, landedAs: dup.state === 'suggested' ? ('suggested' as const) : ('open' as const) };
    }
    // TRAIN-1 (as the db store): a training first seen two weeks past its due date, from a notice that old, goes to Triage.
    const DAY = 86_400_000;
    const nowMs = this.clock.now().getTime();
    const dueMs = parseDue(input.due, this.timeZone);
    const due = Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : undefined;
    const originAt = input.evidence.filter((e) => e.role === 'origin').map((e) => Date.parse(this.sourceItems.get(e.sourceItemId)?.occurredAt ?? '')).filter(Number.isFinite);
    const trainingStale = originAt.length > 0 && input.kind === 'training' && (due ? Date.parse(due) < nowMs - 14 * DAY && Math.max(...originAt) < nowMs - 14 * DAY : Math.max(...originAt) < nowMs - 30 * DAY); // MIN-9: no date, over 30 days old
    const deep = !trainingStale && originAt.length > 0 && staleOnArrival({ originAt: Math.max(...originAt), firstSeenAt: nowMs, dueAt: due ?? null, days: this.closing.oldAskDays }); // DEEP-1: any ask that old
    const pastDue = !trainingStale && !deep && input.kind !== 'training' && !!due && pastDueOnArrival({ dueAt: due, firstSeenAt: nowMs }); // PAST-1
    const staleOverdue = trainingStale || deep || pastDue;
    const statusReason = deep ? stillNeededReason(Math.max(...originAt), nowMs, `scanner:${run.scope.connector}`) : pastDue ? pastDueReason(due!, `scanner:${run.scope.connector}`, this.timeZone) : undefined;
    const landedAs: 'open' | 'suggested' = input.confidence === 'guess' || staleOverdue ? 'suggested' : 'open';
    const id = this.id('wi');
    const w: WorkItemRow = {
      id,
      kind: input.kind,
      title: input.title,
      purpose: input.purpose,
      state: landedAs,
      landedAs,
      newBadge: input.confidence === 'likely',
      confidence: input.confidence,
      due,
      ...(statusReason ? { statusReason } : {}),
      effort: input.effort,
      initiativeId: input.initiativeId,
      accountId: input.accountId,
      oppId: input.oppId,
      expected: input.expected,
      people: new Set(),
      accounts: new Set(input.accountId ? [input.accountId] : []),
      keywords: new Set([...tokenize(input.title), ...tokenize(input.purpose)]),
      threadRefs: new Set(),
      fileRefs: new Set(input.expected?.fileId ? [input.expected.fileId] : []),
      originKey,
      createdRunId: runId,
    };
    this.workItems.set(id, w);
    this.byOriginKey.set(originKey, id);
    this.markPending(run, id);
    input.evidence.forEach((e, i) => this.addEvidence(run, w, sources[i]!, e.role, input.confidence, e.reason));
    return { workItemId: id, landedAs };
  }

  /**
   * DUP-1: an item whose origin shares the conversation and the person of these origins, with the same deliverable.
   * `followUpBy` (R2): the match was closed for me and the asker wrote to me again within the reopen window.
   */
  protected conversationDuplicate(originIds: string[], title: string): { item: WorkItemRow; followUpBy: string | null } | undefined {
    const convOf = (s: SourceItemRow) => {
      const p = (s.payload ?? {}) as { channelId?: string; channelType?: string };
      return (p.channelType === 'im' || p.channelType === 'mpim') && p.channelId ? `dm:${p.channelId}` : s.threadRef;
    };
    const whoOf = (s: SourceItemRow) => (s.author?.isMe ? 'me' : (s.author?.email ?? s.author?.externalId ?? s.author?.name ?? '').toLowerCase());
    const mine = originIds.map((id) => this.sourceItems.get(id)).filter((x): x is SourceItemRow => !!x);
    const keys = new Set(mine.flatMap((s) => (convOf(s) && whoOf(s) ? [`${convOf(s)}|${whoOf(s)}`] : [])));
    if (!keys.size) return undefined;
    const at = Math.max(...mine.map((s) => Date.parse(s.occurredAt)));
    const closed = (w: WorkItemRow) => ['done', 'dismissed', 'merged'].includes(w.state);
    const hits: WorkItemRow[] = [];
    for (const e of this.evidence.values()) {
      if (e.role !== 'origin' || originIds.includes(e.sourceItemId)) continue;
      const o = this.sourceItems.get(e.sourceItemId);
      const w = this.workItems.get(e.workItemId);
      if (!o || !w || !keys.has(`${convOf(o)}|${whoOf(o)}`)) continue;
      if (closed(w) && Math.abs(Date.parse(o.occurredAt) - at) > 14 * 86_400_000) continue;
      // SCN-14: for my commitments the counterpart's name is left out too, not only mine.
      const exclude = nameWords(...mine.map((s) => s.author?.name), ...mine.filter((s) => s.author?.isMe).flatMap((s) => counterpartNames(s.participants)));
      if (sameDeliverable(title, w.title, exclude)) hits.push(w);
    }
    const item = hits.sort((a, b) => Number(closed(a)) - Number(closed(b)))[0];
    if (!item) return undefined;
    const asker = mine.find((s) => !s.author?.isMe);
    const toMe = (s: SourceItemRow) => {
      const p = (s.payload ?? {}) as { channelType?: string; toMe?: boolean; mentionsMe?: boolean; ccMe?: boolean };
      return (s.participants ?? []).some((x) => x.isMe) || p.toMe === true || p.mentionsMe === true || p.ccMe === true || p.channelType === 'im' || p.channelType === 'mpim';
    };
    const after = item.doneAt ? at - Date.parse(item.doneAt) : NaN;
    const followUp = item.state === 'done' && item.doneBy === 'engine' && !!asker && toMe(asker) && this.closing.reopenOnFollowUp && after > 0 && after <= this.reopenWindowMs;
    return { item, followUpBy: followUp ? asker!.author?.name?.trim() || 'the asker' : null };
  }

  async proposeInitiative(runId: string, input: { title: string; purpose: string; accountId?: string; oppId?: string; workItemIds: string[] }) {
    this.mustRunning(runId);
    input.workItemIds.forEach((id) => this.mustWork(id));
    const key = `${input.title.trim().toLowerCase()}|${[...input.workItemIds].sort().join(',')}`;
    const existing = [...this.initiatives.values()].find((i) => i.key === key);
    if (existing) return { initiativeId: existing.id };
    const id = this.id('ini');
    const members = input.workItemIds.map((m) => this.workItems.get(m)!);
    this.initiatives.set(id, {
      id,
      key,
      title: input.title,
      purpose: input.purpose,
      accountId: input.accountId,
      oppId: input.oppId,
      workItemIds: [...input.workItemIds],
      accounts: [...new Set([...(input.accountId ? [input.accountId] : []), ...members.flatMap((m) => [...m.accounts])])],
      keywords: [...new Set(tokenize(`${input.title} ${input.purpose}`))],
    });
    for (const m of members) if (!m.initiativeId) m.initiativeId = id;
    return { initiativeId: id };
  }

  async flagUnlinked(runId: string, input: { sourceItemId: string; reason: string; hints?: string[] }) {
    const run = this.mustRunning(runId);
    this.mustSource(input.sourceItemId);
    const prev = this.unlinked.get(input.sourceItemId);
    const row: UnlinkedRow = prev ?? { sourceItemId: input.sourceItemId, attempts: 0, reason: input.reason, hints: [], deferred: false, lastFlaggedAt: this.nowIso() };
    const deferred = input.reason.startsWith('deferred:');
    if (deferred) row.deferred = true;
    else if (!run.flagged.has(input.sourceItemId)) {
      row.attempts = run.trigger === 'reconcile' ? row.attempts + 1 : Math.max(row.attempts, 1);
      row.deferred = false;
    }
    run.flagged.add(input.sourceItemId);
    row.reason = input.reason;
    if (input.hints?.length) row.hints = [...new Set([...row.hints, ...input.hints])].slice(0, 20);
    row.lastFlaggedAt = this.nowIso();
    this.unlinked.set(input.sourceItemId, row);
  }

  async reportCoverage(runId: string, objects: CoverageObject[]) {
    const run = this.mustRunning(runId);
    for (const o of objects) {
      if (!o.kind || !o.ref) throw new RangeError('reportCoverage: kind and ref are required');
      run.staged.push({ ...o });
    }
  }

  async recordBriefHighlights(runId: string, input: BriefHighlightsInput): Promise<{ briefId: string }> {
    this.mustRunning(runId);
    for (const h of input.highlights) for (const id of h.sourceItemIds) this.mustSource(id);
    const key = `${input.subscription.kind}|${input.subscription.ref}|${input.period.from}|${input.period.to}`;
    const prev = this.briefs.get(key);
    const briefId = prev?.briefId ?? this.id('brief');
    this.briefs.set(key, { ...structuredClone(input), briefId, runId });
    return { briefId };
  }

  async finishRun(runId: string, input: { cursor: Cursor; summary?: string; stats: ScanRunStats }) {
    const run = this.mustRunning(runId);
    const wFrom = toMs(run.window.from)!;
    const wTo = toMs(run.window.to)!;
    const at = toMs(input.cursor.at);
    if (at == null) throw new CoverageError('finishRun: cursor.at is not a timestamp');
    if (at < wFrom - this.tol || at > wTo + this.tol) throw new CoverageError(`finishRun: cursor.at ${input.cursor.at} is outside the run window`);

    // (c) coverage must span [window.from, cursor.at); an incomplete run claims nothing past its cursor (S8c)
    if (at < wTo - this.tol) run.staged = clampToCursor(run.staged, at);
    const ranges = mergeRanges([...this.committedRanges(run.scopeId), ...run.staged.map(rangeOf).filter(isRange)], this.tol);
    const hole = firstHole(ranges, wFrom, at, this.tol);
    if (hole) throw new CoverageError(`finishRun: coverage does not span up to the cursor (hole ${iso(hole.from)} → ${iso(hole.to)})`);

    // (d) commit
    for (const o of run.staged) this.ledgerRows.push({ runId, scopeId: run.scopeId, object: o, ...rangeFields(o), outcome: 'complete' });
    run.staged = [];
    run.status = 'succeeded';
    run.finishedAt = this.nowIso();
    run.cursorAfter = { ...input.cursor };
    run.stats = input.stats;
    run.summary = input.summary;

    // (e) cursor (S9)
    this.advanceCursor(run.scopeId);

    // (f) fan-out set (S10)
    const pending = this.pendingReeval.get(run.scopeId) ?? new Set<string>();
    this.pendingReeval.delete(run.scopeId);
    return { touchedWorkItemIds: [...pending].sort() };
  }

  async failRun(runId: string, input: { error: string; errorClass?: ConnectorHealthProbe['errorClass']; stats?: Partial<ScanRunStats> }) {
    const run = this.runs.get(runId);
    if (!run) throw new RunStateError(`failRun: unknown run ${runId}`);
    if (run.status !== 'running') return; // idempotent
    for (const o of run.staged) this.ledgerRows.push({ runId, scopeId: run.scopeId, object: o, ...rangeFields(o), outcome: 'error' });
    run.staged = [];
    run.status = 'failed';
    run.finishedAt = this.nowIso();
    run.error = input.error;
    run.errorClass = input.errorClass;
    run.stats = input.stats;
  }
}
