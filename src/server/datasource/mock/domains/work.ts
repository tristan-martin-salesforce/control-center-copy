/**
 * The mock DataSource, work domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import { resolutionLabel, id, uniq, I, Res, ITEM_PATCH_LOCK } from '../shared';
import type { MockCtx } from '../ctx';
import { addDays, setHours, setMinutes } from 'date-fns';
import type { AgentRun, Asset, Draft, NbaCard, Resolution, ResolutionDetail, WorkItemDetail, WorkItemRecord } from '@/contract';
import { invalid, notFound } from '@/server/errors';
import { mockResolutionCheck } from '../resolution';
import { isClosedItemState } from '@/outbox/withdraw';
import { docFromText, plainText, renderAll } from '../render';
import { hydrateItem, isLive, itemRef, nowCardFor } from '../views';
import { slackLabels } from '../../draft-source';
import { buildEvidencePayload, whyMentionNames, whyTexts } from '../../evidence-view';
import { initiativeView, workListView } from '@/server/views/work';
import { pageList } from '../../db/reads/page';

/** Is an instant on the user's local day of `now`? (priority@2 pin detection, db parity) */
function sameLocalDay(iso: string, now: Date, timeZone: string): boolean {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const t = Date.parse(iso);
  return Number.isFinite(t) && day(new Date(t)) === day(now);
}

export class MockWork {
  constructor(private readonly ctx: MockCtx) {}

  async listItems({ query }: I<'listItems'>): Promise<Res<'listItems'>> {
    return pageList(workListView(this.ctx.store, query), query); // additive paging, as the db (no limit: unchanged)
  }

  async getItem({ params }: I<'getItem'>): Promise<Res<'getItem'>> {
    return this.itemDetail(params.id);
  }

  private itemDetail(itemId: string): WorkItemDetail {
    const rec = this.ctx.item(itemId);
    const evidence = this.ctx.store.all('evidence').filter((e) => e.workItemId === rec.id);
    const card = nowCardFor(this.ctx.store, rec);
    const ini = rec.initiativeId ? this.ctx.store.get('initiatives', rec.initiativeId) ?? null : null;
    const siblings = ini ? this.ctx.store.all('workItems').filter((w) => w.initiativeId === ini.id && w.id !== rec.id).map((w) => hydrateItem(this.ctx.store, w)) : [];
    const meeting = rec.servesEventId ? this.ctx.store.get('events', rec.servesEventId) ?? null : null;
    return {
      item: card.item,
      nba: card.nba,
      draft: card.draft,
      initiative: ini,
      siblings,
      proposals: card.proposals,
      runs: rec.runIds.map((r) => this.ctx.store.get('agentRuns', r)).filter((r): r is AgentRun => !!r),
      assets: uniq([...rec.assetIds, ...(ini?.assetIds ?? [])]).map((a) => this.ctx.store.get('assets', a)).filter((a): a is Asset => !!a),
      account: rec.accountId ? this.ctx.store.get('accounts', rec.accountId) ?? null : null,
      opp: rec.oppId ? this.ctx.store.get('opps', rec.oppId) ?? null : null,
      meeting,
      evidenceCount: evidence.length,
      mentions: whyMentionNames(whyTexts(card.item, card.nba), evidence, slackLabels(this.ctx.store.all('people'))),
    };
  }

  async captureItem({ body }: I<'captureItem'>): Promise<Res<'captureItem'>> {
    const { item, entry } = this.captureInternal(body, 'user');
    return { entity: item, auditId: entry?.id ?? null };
  }

  /** Quick capture. Users lock the title they typed; chat captures lock nothing (only user edits lock). */
  captureInternal(body: { text: string; accountId?: string; initiativeId?: string; due?: string }, actor: 'user' | 'chat') {
    const byUser = actor === 'user';
    const now = this.ctx.nowIso();
    let text = body.text.trim();
    let youMin = 15;
    const eff = /~(\d+)\s*(m|min|h)\b/i.exec(text);
    if (eff) {
      youMin = eff[2].toLowerCase() === 'h' ? Number(eff[1]) * 60 : Number(eff[1]);
      text = text.replace(eff[0], '').trim();
    }
    let accountId = body.accountId ?? null;
    const acc = /#([\w-]+)/.exec(text);
    if (acc) {
      const match = this.ctx.store.all('accounts').find((a) => a.name.toLowerCase().startsWith(acc[1].toLowerCase()));
      if (match) accountId = match.id;
      text = text.replace(acc[0], match?.name ?? acc[1]).trim();
    }
    const rec: WorkItemRecord = {
      id: id('w'),
      version: 1,
      kind: 'task',
      state: 'open',
      title: text.replace(/\s+/g, ' '),
      purpose: null,
      initiativeId: body.initiativeId ?? null,
      accountId,
      oppId: null,
      servesEventId: null,
      confidence: 'sure',
      why: byUser ? 'Captured by you' : 'Captured from chat',
      whyDetail: null,
      sources: [{ kind: 'manual', label: byUser ? 'Quick capture' : 'Chat capture', at: now }],
      effort: { youMin, agentMin: 0 },
      startBy: null,
      due: body.due ?? null,
      createdAt: now,
      updatedAt: now,
      ageDays: 0,
      isBackground: false,
      rank: null,
      rankReasons: [],
      score: null,
      priority: 'medium',
      signals: { customerFacing: !!accountId, fromManager: false, boost: 0 },
      stale: null,
      userLockedFields: byUser ? ['title'] : [],
      newEvidenceCount: 0,
      reevaluating: true,
      seenAt: now,
      nbaId: null,
      owner: { id: this.ctx.store.meta().user.id, name: this.ctx.store.meta().user.name },
      people: [],
      waiting: null,
      snoozedUntil: null,
      snoozedFrom: null,
      doneAt: null,
      doneBy: null,
      closedReason: null,
      resolution: null,
      resolutionDetail: null,
      involvement: 'owner',
      loopedBackIn: null,
      likelyDone: null,
      reopened: null,
      dismissed: null,
      notes: '',
      enrichment: { status: 'enriching', startedAt: now, chips: [] },
      deliverable: null,
      training: null,
      runIds: [],
      assetIds: [],
      counterparty: null,
    };
    const { entry, ops } = this.ctx.tx({ actor, action: byUser ? 'item.capture' : 'chat.capture', summary: `Captured: ${rec.title}`, entity: itemRef(rec) }, (tx) => {
      tx.put('workItems', rec);
      this.ctx.addEvidence(tx, rec.id, 'origin', { kind: 'manual', label: byUser ? 'Quick capture' : 'Chat capture' }, rec.why, false);
    });
    this.ctx.later(this.ctx.delays.enrichMs, () => this.enrich(rec.id));
    return { item: hydrateItem(this.ctx.store, rec), entry, ops };
  }

  enrich(itemId: string) {
    const cur = this.ctx.store.get('workItems', itemId);
    if (!cur) return;
    const words = cur.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !['the', 'and', 'for', 'with', 'about', 'talk', 'team'].includes(w));
    const hit = (s: string) => words.find((w) => s.toLowerCase().includes(w));
    const chips: NonNullable<WorkItemRecord['enrichment']>['chips'] = [];
    for (const r of this.ctx.store.all('agentRuns')) {
      const w = r.kind === 'claude_session' ? hit(r.title) : undefined;
      if (w && chips.length < 4) chips.push({ id: id('chip'), kind: 'claude_session', label: `Claude session '${r.title}'`, reason: `Mentions "${w}"`, ref: { type: 'agent_run', id: r.id, label: r.title }, url: r.deepLink ?? undefined, status: 'suggested' });
    }
    for (const a of this.ctx.store.all('assets')) {
      const w = hit(a.title);
      if (w && chips.length < 4) chips.push({ id: id('chip'), kind: 'asset', label: `${a.kind === 'doc' ? 'Doc' : a.kind === 'slides' ? 'Deck' : 'File'} '${a.title}' (${a.source === 'drive' ? 'Drive' : a.source})`, reason: `Title matches "${w}"`, ref: { type: 'asset', id: a.id, label: a.title }, url: a.url, status: 'suggested' });
    }
    for (const b of this.ctx.store.all('briefs')) {
      const w = hit(b.title) ?? hit(b.summary);
      if (w && chips.length < 4) chips.push({ id: id('chip'), kind: 'slack_thread', label: `Slack thread in ${b.title}`, reason: `Discusses "${w}"`, ref: { type: 'brief', id: b.id, label: b.title }, status: 'suggested' });
    }
    const person = this.ctx.store.all('people').find((p) => hit(p.name) || (p.role && hit(p.role)));
    const asset = chips.find((c) => c.kind === 'asset');
    const nbaId = id('nba');
    let draft: Draft | null = null;
    // OUTBOX-W: closed before enrichment finished: no reply draft for a closed to-do (like the db's read-in commit)
    if (person && !isClosedItemState(cur.state)) {
      const txt = `Hi ${person.name.split(' ')[0]}, following up on: ${cur.title}.${asset ? `\n\nHere is the doc I mentioned: ${asset.label}` : ''}\n\nDo you have 15 minutes this week?`;
      const doc = docFromText(txt);
      const dest = { kind: 'slack' as const, target: 'dm' as const, channelId: person.slackHandle ?? person.id, channelName: `@${person.name}`, threadTs: null };
      draft = {
        id: id('dr'),
        version: 1,
        workItemId: cur.id,
        nbaId,
        destination: dest,
        mode: this.ctx.store.settings().sending.defaultMode,
        doc,
        plainText: plainText(doc),
        rendered: renderAll(dest, doc),
        userTouched: false,
        userLockedFields: [],
        status: 'drafting',
        threadContext: [],
        createdAt: this.ctx.nowIso(),
        updatedAt: this.ctx.nowIso(),
        savedAt: null,
        scheduledFor: null,
        attempts: [],
        verification: null,
        rejectedReason: null,
        resultUrl: null,
      };
    }
    const nba: NbaCard = {
      id: nbaId,
      workItemId: cur.id,
      version: 1,
      verb: draft ? 'send' : 'review',
      primaryLabel: draft ? 'Send' : 'Review related work',
      confidence: chips.length ? 'likely' : 'guess',
      title: draft && person ? `Message ${person.name}: ${cur.title}` : `Review ${chips.length} related item${chips.length === 1 ? '' : 's'}`,
      why: chips.length ? `Found ${chips.length} related item${chips.length === 1 ? '' : 's'} after capture` : 'No related work found yet',
      whyDetail: null,
      sources: [{ kind: 'manual', label: 'Quick capture' }],
      status: 'ready',
      draftId: draft?.id ?? null,
      alternatives: [],
      toolAdapterId: null,
      toolInputs: null,
      claudeLaunch: null,
      runId: null,
      update: null,
      versions: [{ version: 1, at: this.ctx.nowIso(), reason: 'Generated after enrichment', diffSummary: null }],
      generatedAt: this.ctx.nowIso(),
      model: 'mock',
    };
    this.ctx.tx({ actor: 'engine', action: 'item.enrich', summary: `Enriched: ${cur.title}`, entity: itemRef(cur) }, (tx) => {
      if (draft) tx.put('drafts', draft);
      tx.put('nbas', nba);
      tx.put('workItems', this.ctx.bump({ ...cur, reevaluating: false, enrichment: { status: 'done', startedAt: cur.enrichment?.startedAt ?? null, chips }, nbaId: nba.id, people: person ? [{ id: person.id, name: person.name, role: person.role }] : cur.people }));
    });
  }

  async patchItem({ params, body }: I<'patchItem'>): Promise<Res<'patchItem'>> {
    const cur = this.ctx.item(params.id);
    this.ctx.checkVersion(cur, body.ifVersion, 'Work item', hydrateItem(this.ctx.store, cur));
    const locks = new Set(cur.userLockedFields);
    for (const k of Object.keys(body.patch)) if (ITEM_PATCH_LOCK[k]) locks.add(ITEM_PATCH_LOCK[k]);
    const next = this.ctx.bump({ ...cur, ...body.patch, userLockedFields: [...locks] } as WorkItemRecord);
    // priority@2 R8 (db parity): a start-by pulled into today is a pin, a boost a reorder
    const patch = body.patch as Partial<WorkItemRecord>;
    const tz = this.ctx.store.settings().profile.timezone;
    if (patch.startBy && sameLocalDay(patch.startBy, this.ctx.now(), tz) && (!cur.startBy || !sameLocalDay(cur.startBy, this.ctx.now(), tz))) this.ctx.ds.priority.record(this.ctx.store, this.ctx.now(), { itemId: cur.id, action: 'pin', fromRank: cur.rank, toRank: null });
    else if (patch.signals && patch.signals.boost !== cur.signals.boost && cur.rank !== null) this.ctx.ds.priority.record(this.ctx.store, this.ctx.now(), { itemId: cur.id, action: 'reorder', fromRank: cur.rank, toRank: Math.max(1, cur.rank + (patch.signals.boost > cur.signals.boost ? -1 : 1)) });
    const { entry } = this.ctx.tx({ actor: 'user', action: 'item.edit', summary: `Edited: ${cur.title}`, entity: itemRef(cur), coalesceKey: `item:${cur.id}` }, (tx) => tx.put('workItems', next));
    return { entity: hydrateItem(this.ctx.store, next), auditId: entry?.id ?? null };
  }

  async itemAction({ params, body }: I<'itemAction'>): Promise<Res<'itemAction'>> {
    const cur = this.ctx.item(params.id);
    this.ctx.checkVersion(cur, body.ifVersion, 'Work item', hydrateItem(this.ctx.store, cur));
    const now = this.ctx.nowIso();
    const done = (reason: string, resolution: Resolution = 'done_by_me'): WorkItemRecord =>
      this.resolvedRecord(cur, { reason, resolution, detail: body.detail ?? {}, involvement: body.involvement, doneBy: 'user' });
    let next: WorkItemRecord;
    let label: string;
    switch (params.verb) {
      case 'done':
        if (!isLive(cur) && cur.state !== 'snoozed' && cur.state !== 'suggested') throw invalid(`Cannot mark a ${cur.state} item done`);
        next = done(body.resolution && body.resolution !== 'done_by_me' ? resolutionLabel(body.resolution, body.detail?.personName) : 'Marked done by you', body.resolution ?? 'done_by_me');
        label = 'Done';
        break;
      case 'resolve':
        if (!body.resolution) throw invalid('resolve needs a `resolution`');
        if (!isLive(cur) && cur.state !== 'snoozed' && cur.state !== 'suggested' && cur.state !== 'done') throw invalid(`Cannot resolve a ${cur.state} item`);
        next = done(resolutionLabel(body.resolution, body.detail?.personName ?? (body.detail?.personId ? this.ctx.store.get('people', body.detail.personId)?.name : undefined)), body.resolution);
        label = 'Resolved';
        break;
      case 'snooze':
        if (!body.until) throw invalid('snooze needs `until`');
        if (!isLive(cur) && cur.state !== 'snoozed') throw invalid(`Cannot snooze a ${cur.state} item`);
        next = { ...cur, state: 'snoozed', snoozedUntil: body.until, snoozedFrom: cur.state === 'snoozed' ? cur.snoozedFrom : cur.state };
        label = 'Snoozed';
        break;
      case 'accept':
        if (cur.state !== 'suggested') throw invalid('Only suggested items can be accepted');
        next = { ...cur, state: 'open', confidence: cur.confidence === 'guess' ? 'likely' : cur.confidence };
        label = 'Accepted';
        break;
      case 'dismiss':
        next = { ...cur, state: 'dismissed', dismissed: { reason: body.reason ?? 'other', note: body.note, at: now } };
        label = 'Dismissed';
        break;
      case 'confirm-done':
        if (cur.state !== 'likely_done') throw invalid('Only likely-done items can be confirmed');
        next = done(cur.likelyDone?.reason ?? 'Confirmed done');
        label = 'Confirmed done';
        break;
      case 'not-done':
        // LD-1: the mock keeps no transition log; in_progress is the closure machine's own step-back.
        if (cur.state !== 'likely_done') throw invalid('Only likely-done items can be marked not done');
        next = { ...cur, state: 'in_progress', likelyDone: null };
        label = 'Not done';
        break;
      case 'reopen':
        if (cur.state !== 'done' && cur.state !== 'dismissed') throw invalid('Only done or dismissed items can be reopened');
        // OUTBOX-W: drafts withdrawn when it closed stay discarded; the user can draft again (Undo of the close restores them).
        next = { ...cur, state: 'reopened', doneAt: null, doneBy: null, closedReason: null, dismissed: null, resolution: null, resolutionDetail: null, involvement: 'owner', reopened: { reason: body.note ?? 'Reopened by you', at: now } };
        label = 'Reopened';
        break;
      case 'not-now': {
        if (!body.reason) throw invalid('not-now needs a `reason` (done_elsewhere · not_mine · later · wrong_account · other)');
        label = 'Not now';
        if (body.reason === 'done_elsewhere') next = done('Done elsewhere');
        else if (body.reason === 'later') {
          const until = body.until ?? setMinutes(setHours(addDays(this.ctx.now(), 1), 9), 0).toISOString();
          next = { ...cur, state: 'snoozed', snoozedUntil: until, snoozedFrom: cur.state };
        } else if (body.reason === 'wrong_account') next = { ...cur, accountId: null, oppId: null, notes: `${cur.notes}${cur.notes ? '\n' : ''}Wrong account (not now)` };
        else next = { ...cur, state: 'dismissed', dismissed: { reason: body.reason, note: body.note, at: now } };
        break;
      }
    }
    next = this.ctx.bump(next);
    // priority@2 R8 (db parity): a snooze or a "not today" of ranked work feeds the learning loop
    if (cur.rank !== null && (params.verb === 'snooze' || (params.verb === 'not-now' && body.reason === 'later'))) this.ctx.ds.priority.record(this.ctx.store, this.ctx.now(), { itemId: cur.id, action: params.verb === 'snooze' ? 'snooze' : 'not_today', fromRank: cur.rank, toRank: null });
    const { entry } = this.ctx.tx({ actor: 'user', action: `item.${params.verb}`, summary: `${label}: ${cur.title}`, entity: itemRef(cur) }, (tx) => tx.put('workItems', next));
    return { entity: hydrateItem(this.ctx.store, next), auditId: entry?.id ?? null };
  }

  /** The closed record for done / resolve / confirm-done (user) and chat's resolveItem. */
  resolvedRecord(
    cur: WorkItemRecord,
    o: { reason: string; resolution: Resolution; detail: Partial<Omit<ResolutionDetail, 'inferred'>>; involvement?: 'watcher' | 'not_involved' | 'contributor'; doneBy: 'user' | 'chat' },
  ): WorkItemRecord {
    const { detail, resolution } = o;
    const person = detail.personId ? this.ctx.store.get('people', detail.personId) : detail.personName ? this.ctx.store.all('people').find((p) => p.name === detail.personName) : undefined;
    const personName = detail.personName ?? person?.name;
    if (resolution === 'handed_off' && !personName) throw invalid('handed_off needs detail.personId or detail.personName (who took it over)');
    if ((resolution === 'duplicate' || resolution === 'superseded') && detail.relatedItemId && !this.ctx.store.get('workItems', detail.relatedItemId)) throw notFound('Related work item', detail.relatedItemId);
    return {
      ...cur,
      state: 'done',
      doneAt: this.ctx.nowIso(),
      doneBy: o.doneBy,
      closedReason: o.reason,
      likelyDone: null,
      waiting: null,
      snoozedUntil: null,
      resolution,
      resolutionDetail: { inferred: false, ...detail, ...(personName ? { personName } : {}), ...(person ? { personId: person.id } : {}) },
      involvement: resolution === 'handed_off' ? (o.involvement ?? 'watcher') : cur.involvement,
      owner: resolution === 'handed_off' && personName ? { id: person?.id ?? `person:${personName}`, name: personName } : cur.owner,
      loopedBackIn: null,
    };
  }

  async getItemEvidence({ params }: I<'getItemEvidence'>): Promise<Res<'getItemEvidence'>> {
    this.ctx.item(params.id);
    const evidence = this.ctx.store.all('evidence').filter((e) => e.workItemId === params.id);
    return buildEvidencePayload(params.id, evidence, slackLabels(this.ctx.store.all('people')));
  }

  /** H-7 "Why is this still open?": one synthetic check (mock/resolution.ts). */
  async getResolutionCheck({ params }: I<'getResolutionCheck'>): Promise<Res<'getResolutionCheck'>> {
    return mockResolutionCheck(this.ctx.item(params.id), this.ctx.clock.now(), this.ctx.store.settings().closing.resolutionEngine);
  }

  async getItemTrace({ params }: I<'getItemTrace'>): Promise<Res<'getItemTrace'>> {
    this.ctx.item(params.id);
    // The mock has no scan runs: the chain stops at each source (with its link).
    const steps = this.ctx.store
      .all('evidence')
      .filter((e) => e.workItemId === params.id)
      .sort((a, b) => (a.role === 'origin' ? -1 : 0) - (b.role === 'origin' ? -1 : 0) || a.at.localeCompare(b.at))
      .map((e) => ({ evidenceId: e.id, role: e.role, confidence: e.confidence === 'sure' ? 0.95 : e.confidence === 'likely' ? 0.75 : e.confidence === 'guess' ? 0.45 : null, rationale: e.summary || null, at: e.at, source: e.source, sourceItemId: null, run: null, verdict: null, spend: null }));
    return { workItemId: params.id, steps, createdBy: null };
  }

  async getItemHistory({ params }: I<'getItemHistory'>): Promise<Res<'getItemHistory'>> {
    const rec = this.ctx.item(params.id);
    const nba = rec.nbaId ? this.ctx.store.get('nbas', rec.nbaId) : undefined;
    const entries = this.ctx.audit.forEntity('work_item', rec.id);
    if (nba) entries.push(...this.ctx.audit.forEntity('nba', nba.id).filter((e) => !entries.includes(e)));
    return { workItemId: rec.id, entries: entries.sort((a, b) => b.at.localeCompare(a.at)), nbaVersions: nba?.versions ?? [] };
  }

  async markItemSeen({ params }: I<'markItemSeen'>): Promise<Res<'markItemSeen'>> {
    const cur = this.ctx.item(params.id);
    const { result } = this.ctx.tx({ actor: 'user', action: 'item.seen', summary: 'Seen', entity: itemRef(cur), audit: false }, (tx) => {
      for (const e of this.ctx.store.all('evidence')) if (e.workItemId === cur.id && e.isNew) tx.put('evidence', { ...e, isNew: false });
      return tx.put('workItems', { ...cur, newEvidenceCount: 0, seenAt: this.ctx.nowIso() });
    });
    return { entity: hydrateItem(this.ctx.store, result), auditId: null };
  }

  async getInitiative({ params }: I<'getInitiative'>): Promise<Res<'getInitiative'>> {
    return initiativeView(this.ctx.store, this.ctx.store.must('initiatives', params.id, 'Initiative'));
  }
}
