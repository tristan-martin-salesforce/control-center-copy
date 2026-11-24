/**
 * Scripted "agents" that follow skills/scan-slack.md, scan-org62 and a gmail-like deterministic skill,
 * using the slack simulator for tool results and the real cc handlers for every write.
 */
import type { Script, ScriptApi } from './scripted-runner';
import { loadCorpus, parseSlackSearch, slackRecordItem, slackSearch, type Corpus, type ParsedHit } from './slack-sim';

/** Scripted titles per corpus message (the model would write these; the skill says verb + deliverable + person). */
export const TITLES: Record<string, { kind: 'ask' | 'commitment'; title: string; purpose: string }> = {
  'promise-desktop': { kind: 'commitment', title: 'Package APP_X as a desktop app for PERSON_B', purpose: 'PERSON_B and others can install APP_X without running a node project' },
  'deck-ask': { kind: 'ask', title: 'Send ACME demo deck to PERSON_D', purpose: 'PERSON_D needs the ACME demo deck before Friday' },
  'pricing-ask': { kind: 'ask', title: 'Update pricing slide in ACME POV deck', purpose: 'Customer wants the new pricing tiers in the ACME POV deck' },
  'weekend-ask': { kind: 'ask', title: 'Review GLOBEX sizing sheet for PERSON_G', purpose: 'PERSON_G wants a review of the GLOBEX sizing sheet Monday' },
  'handoff-ask': { kind: 'ask', title: 'Join Friday review for PERSON_E', purpose: 'Architecture section of the GLOBEX review' },
};

const ASK = /\b(can|could|would) you\b|\bplease\b|\?$/i;
const COMMIT_STRONG = /\b(I'll|I will|will send|will share|on it)\b/i;
const COMMIT_MEDIUM = /\b(I'm going to|I am going to|going to figure out|let me look into)\b/i;
const COMPLETION = /\b(done|sent|shared|here's|here is|attached)\b|see deck/i;
const NOISE = /^(thanks|thx|ty|lol|ok)\b[^?]*$/i;
const SECRET = /password|login is/i;

export interface SlackAgentOptions {
  corpus?: Corpus;
  /** Abort (simulated kill) after this many cc_record_source_items calls. */
  killAfterRecords?: number;
  onKill?: () => void;
  /** Simulated spend per run. */
  costUsd?: number;
  /** Cap pages per query (skill: 3). Set lower to force a continuation. */
  maxPages?: number;
  pageLimit?: number;
}

export function slackAgent(opts: SlackAgentOptions = {}): Script {
  const corpus = opts.corpus ?? loadCorpus();
  return async (api: ScriptApi) => {
    const { input } = api;
    const me = input.context.me.slackId ?? corpus.me.slackId;
    const scope = input.context.scope.scope;
    const w = input.window!;
    const toUnix = Math.floor(Date.parse(w.to) / 1000);
    const afterUnix = Math.floor(Date.parse(w.from) / 1000) - 120;
    api.spend(opts.costUsd ?? 0.002, 0);
    const queries: Array<{ ref: string; query: string; channel_types: string; q: string; kind?: 'channel_range' }> =
      scope === 'inbox'
        ? [
            { ref: 'search:dm', query: `-from:<@${me}>`, channel_types: 'im,mpim', q: 'dm' },
            { ref: 'search:mentions', query: `<@${me}>`, channel_types: 'public_channel,private_channel', q: 'mentions' },
            { ref: 'search:mine', query: `from:<@${me}>`, channel_types: 'public_channel,private_channel,mpim,im', q: 'mine' },
          ]
        : scope.startsWith('channel:')
          ? [{ ref: `search:channel:${scope.slice(8)}`, query: `in:<#${scope.slice(8)}>`, channel_types: 'public_channel,private_channel', q: 'channel', kind: 'channel_range' as const }]
          : [];
    let records = 0;
    const windows: Array<{ kind?: 'query_window' | 'channel_range'; ref: string; from: string; to: string }> = [];
    let frontier: ParsedHit | undefined;
    for (const q of queries) {
      api.toolCall('mcp__slack__slack_search_public_and_private');
      let page = 1;
      let cursor: string | undefined;
      let last: ParsedHit | undefined;
      let pagedOut = false;
      for (;;) {
        const raw = slackSearch(corpus, { query: q.query, channel_types: q.channel_types, after: String(afterUnix), before: String(toUnix), limit: opts.pageLimit ?? 20, cursor });
        const hits = parseSlackSearch(raw.results);
        if (hits.length) {
          const rec = await api.call<{ items: Array<{ id: string; ext: string }> }>('cc_record_source_items', {
            items: hits.map((h) => slackRecordItem(h, me, { query: q.q, accountHints: h.channelId === 'C0ACME001' ? ['ACME'] : undefined })),
          });
          records += 1;
          if (opts.killAfterRecords && records >= opts.killAfterRecords) {
            opts.onKill?.();
            throw new Error('killed');
          }
          for (let i = 0; i < hits.length; i++) await decide(api, corpus, me, hits[i]!, rec.items[i]!.id);
          last = hits[hits.length - 1];
        }
        const next = /cursor `([^`]+)`/.exec(raw.pagination_info)?.[1];
        if (!next) break;
        if (page >= (opts.maxPages ?? 3)) {
          pagedOut = true;
          break;
        }
        cursor = next;
        page += 1;
      }
      const to = pagedOut && last ? last.ts : w.to;
      windows.push({ ...(q.kind ? { kind: q.kind } : {}), ref: q.ref, from: w.from, to });
      if (pagedOut && last && (!frontier || Number(last.ts) < Number(frontier.ts))) frontier = last;
    }
    if (windows.length) await api.call('cc_report_coverage', { windows });
    if (frontier) await api.call('cc_finish', { cursor: { value: frontier.ts, at: frontier.ts }, complete: false, summary: 'paged out' });
    else await api.call('cc_finish', { cursor: { value: `${toUnix}.000000`, at: w.to }, complete: true });
  };
}

function corpusId(corpus: Corpus, h: ParsedHit): string | undefined {
  return corpus.messages.find((m) => m.ts === h.ts && m.channel === h.channelId)?.id;
}

async function decide(api: ScriptApi, corpus: Corpus, me: string, h: ParsedHit, sourceItemId: string) {
  const isMe = h.fromId === me;
  const text = h.text;
  if (NOISE.test(text) || SECRET.test(text)) return; // record only
  const id = corpusId(corpus, h);
  const counterpart = isMe ? h.participants.filter((p) => p.id !== me).flatMap((p) => [p.name, p.id]) : [h.fromName, h.fromId];
  const threadRef = `slack:${h.channelId}:${h.threadTs ?? h.ts}`;
  const files = [...text.matchAll(/docs\.google\.com\/[a-z]+\/d\/([A-Za-z0-9_-]+)/g)].map((m) => `drive:${m[1]}`);
  const words = text.replace(/<@[A-Z0-9]+>/g, '').replace(/https?:\S+/g, '');
  const { candidates } = await api.call<{ candidates: Array<{ w?: string; s: number; why: string; st?: string; res?: string; inv?: string }> }>('cc_find_candidates', {
    threadRefs: [threadRef],
    files: files.length ? files : undefined,
    people: counterpart,
    text: words.slice(0, 200),
  });
  const top = candidates.find((c) => c.w);
  const direct = !isMe && (corpus.channels[h.channelId]?.type === 'im' || text.includes(`<@${me}>`));
  const link = (role: string, confidence: string, reason: string) => api.call('cc_link_evidence', { workItemId: top!.w, sourceItemId, role, confidence, reason });

  // R-UI-22: handed-off / watcher items take context only, except a direct ask (loop-back).
  if (top && top.s >= 0.5 && (top.res === 'handed_off' || top.inv === 'watcher' || top.inv === 'not_involved')) {
    if (direct && ASK.test(text)) return link('origin', 'sure', `loop_back: ${h.fromName} asked me directly`);
    return link('context', 'sure', 'update on a handed-off item');
  }
  if (isMe && COMPLETION.test(text)) {
    if (top && top.s >= 0.5) return link('completion', top.why.includes('same thread') || top.why.includes('same file') ? 'sure' : 'likely', 'my reply delivers it');
    return api.call('cc_flag_unlinked', { sourceItemId, reason: `my completion message with no matching item: ${words.slice(0, 80)}`, hints: counterpart });
  }
  if (isMe && (COMMIT_STRONG.test(text) || COMMIT_MEDIUM.test(text))) {
    if (top && top.s >= 0.5) return link('origin', 'sure', 'my commitment on this deliverable');
    const t = TITLES[id ?? ''];
    if (!t) return api.call('cc_flag_unlinked', { sourceItemId, reason: `my commitment, no home: ${words.slice(0, 80)}`, hints: counterpart });
    return api.call('cc_propose_item', { kind: 'commitment', title: t.title, purpose: t.purpose, confidence: COMMIT_STRONG.test(text) ? 'sure' : 'likely', evidence: [{ sourceItemId, role: 'origin', reason: 'my commitment' }] });
  }
  if (!isMe && direct && ASK.test(text)) {
    if (top && top.st === 'done' && top.why.includes('same thread')) return link('contradiction', 'sure', 'requirements_change: new ask after done');
    if (top && top.s >= 0.6) return link('origin', 'sure', 'ask on this item');
    const t = TITLES[id ?? ''];
    if (t) return api.call('cc_propose_item', { kind: t.kind, title: t.title, purpose: t.purpose, confidence: 'sure', evidence: [{ sourceItemId, role: 'origin', reason: 'direct ask of me' }] });
  }
  if (top && top.s >= 0.5) return link('context', 'likely', 'related update');
  if (/ACME|GLOBEX|APP_X/.test(text)) return api.call('cc_flag_unlinked', { sourceItemId, reason: `${h.fromName}: ${words.slice(0, 100)}`, hints: [h.fromName, ...(text.match(/ACME|GLOBEX|APP_X/g) ?? [])] });
}

/** A gmail-like deterministic skill agent: links prefetched sent mail as completion of a matching commitment. */
export function mailAgent(): Script {
  return async (api) => {
    for (const it of api.input.prefetched ?? []) {
      const id = api.recordedId(it.dedupeKey)!;
      const people = (it.participants ?? []).filter((p) => !p.isMe).flatMap((p) => [p.name, p.email].filter(Boolean) as string[]);
      const { candidates } = await api.call<{ candidates: Array<{ w?: string; s: number; why: string }> }>('cc_find_candidates', { people, files: it.fileRefs, threadRefs: it.threadRef ? [it.threadRef] : undefined, text: `${it.title ?? ''} ${it.excerpt ?? ''}`.slice(0, 200) });
      const top = candidates.find((c) => c.w);
      if (it.author?.isMe && /attached|as promised|here is/i.test(it.excerpt ?? '') && top && top.s >= 0.5) {
        await api.call('cc_link_evidence', { workItemId: top.w, sourceItemId: id, role: 'completion', confidence: 'sure', reason: 'sent the deck by email to the person it was promised to' });
      } else if (top && top.s >= 0.5) {
        await api.call('cc_link_evidence', { workItemId: top.w, sourceItemId: id, role: 'context', confidence: 'likely', reason: 'related mail' });
      }
    }
    const h = api.input.vars ?? {};
    await api.call('cc_finish', { cursor: { value: String(h['header.cursor.value']), at: String(h['header.cursor.at']) }, complete: h['header.complete'] === 'true' });
  };
}

/** Relink agent that never finds a home (to drive retry → escalate → triage). */
export function stubbornRelinkAgent(): Script {
  return async (api) => {
    const items = JSON.parse(api.input.instruction!.split('## Unlinked items\n')[1]!) as Array<{ sourceItemId: string; reason: string; hints?: string[] }>;
    for (const it of items) await api.call('cc_flag_unlinked', { sourceItemId: it.sourceItemId, reason: it.reason, hints: it.hints });
    await api.call('cc_finish', { cursor: { value: 'relink', at: api.input.window!.to } });
  };
}

/** Org62 agent following scan-org62 §2/§4/§5 over recorded SOQL fixtures. */
export function org62Agent(fixtures: { team?: any; dcs?: any; events?: any }): Script {
  return async (api) => {
    const scope = api.input.context.scope.scope;
    const w = api.input.window!;
    const windows: Array<{ ref: string; from: string; to: string }> = [];
    api.toolCall('mcp__Org62-Sobject-Read__soqlQuery');
    if (scope === 'opps' && fixtures.team) {
      const items = fixtures.team.records.map((r: any) => ({
        kind: 'record_snapshot',
        externalId: `Opportunity:${r.OpportunityId}@${r.Opportunity.SystemModstamp}`,
        occurredAt: r.Opportunity.SystemModstamp,
        title: r.Opportunity.Name,
        excerpt: `stage=${r.Opportunity.StageName}; close=${r.Opportunity.CloseDate}; amount=${r.Opportunity.Amount}; next=${r.Opportunity.NextStep ?? ''}; team_role=${r.TeamMemberRole}`,
        oppHints: [r.OpportunityId],
        accountHints: [r.Opportunity.AccountId, r.Opportunity.Account.Name],
        payload: { Id: r.OpportunityId, StageName: r.Opportunity.StageName, CloseDate: r.Opportunity.CloseDate, Amount: r.Opportunity.Amount, TeamMemberRole: r.TeamMemberRole },
      }));
      const rec = await api.call<{ items: Array<{ id: string }> }>('cc_record_source_items', { items });
      for (let i = 0; i < items.length; i++) {
        const r = fixtures.team.records[i];
        const newOnTeam = r.SystemModstamp >= w.from.replace('Z', '') || Date.parse(r.SystemModstamp) >= Date.parse(w.from);
        const { candidates } = await api.call<{ candidates: Array<{ w?: string; s: number }> }>('cc_find_candidates', { accounts: [r.Opportunity.Account.Name], text: `${r.Opportunity.Name} ${r.Opportunity.NextStep ?? ''}` });
        const top = candidates.find((c) => c.w);
        if (top && top.s >= 0.5) await api.call('cc_link_evidence', { workItemId: top.w, sourceItemId: rec.items[i]!.id, role: 'context', confidence: 'likely', reason: 'opp changed' });
        else if (newOnTeam) await api.call('cc_propose_item', { kind: 'follow_up', title: `Get up to speed on ${r.Opportunity.Name}`, oppId: r.OpportunityId, confidence: 'guess', evidence: [{ sourceItemId: rec.items[i]!.id, role: 'origin', reason: 'added to opp team' }] });
      }
      windows.push({ ref: 'soql:OpportunityTeamMember', from: w.from, to: w.to });
    }
    if (scope === 'dcs' && fixtures.dcs) {
      const items = fixtures.dcs.records.map((r: any) => ({
        kind: 'record_snapshot',
        externalId: `Deal_Contribution__c:${r.Id}@${r.SystemModstamp}`,
        occurredAt: r.SystemModstamp,
        title: `DC on ${r.Opportunity__r.Name}`,
        excerpt: `role=${r.Opportunity_Role__c}; split=${r.Split_Percentage__c}; opp_stage=${r.Opportunity__r.StageName}; close=${r.Opportunity__r.CloseDate}`,
        oppHints: [r.Opportunity__c],
      }));
      const rec = await api.call<{ items: Array<{ id: string }> }>('cc_record_source_items', { items });
      for (let i = 0; i < items.length; i++) {
        const r = fixtures.dcs.records[i];
        const { candidates } = await api.call<{ candidates: Array<{ w?: string; s: number }> }>('cc_find_candidates', { text: `claim DC ${r.Opportunity__r.Name}` });
        const top = candidates.find((c) => c.w);
        if (top && top.s >= 0.3) await api.call('cc_link_evidence', { workItemId: top.w, sourceItemId: rec.items[i]!.id, role: 'completion', confidence: 'sure', reason: 'Deal_Contribution__c created, AI + Data Architect 100%' });
      }
      windows.push({ ref: 'soql:Deal_Contribution__c', from: w.from, to: w.to });
    }
    if (!windows.length) windows.push({ ref: `soql:${scope}`, from: w.from, to: w.to });
    await api.call('cc_report_coverage', { windows });
    await api.call('cc_finish', { cursor: { value: w.to.replace(/\.\d{3}Z$/, 'Z'), at: w.to }, complete: true });
  };
}
