/**
 * Org62 fetched by code (FTI): the windowed queries of skills/scan-org62.md §2, each page one `soqlQuery` through the
 * `claude_relay` runtime, recorded by REC-2 (Org62AutoRecorder: the same record snapshots, externalIds and hashes as
 * the agentic path). Code owns what the skill asked the model to do:
 *
 *   paging     ORDER BY SystemModstamp, Id with the skill's LIMIT (opps 50, Events 40, DCs 100); a full page reads on
 *              with `AND (SystemModstamp > <last> OR (SystemModstamp = <last> AND Id > '<last id>'))` (the
 *              Opportunity.* prefix for the team query); a run reads up to `maxPages` pages per query, then finishes
 *              incomplete at the earliest row a full query stopped on (`<stamp>|<id>`, ORG-3/5/6 as the main path)
 *   overflow   a result over the tool's output cap holds no rows: the same page again at half the LIMIT (≥ 10, ORG-1/4)
 *   continuation  a `<stamp>|<id>` cursor puts the paging filter on the first page
 *
 * Scopes: `opps` (Q1 my opp teams, Q2 opps on my accounts when there are any, Q3 opps I own when the persona's book is
 * `owner` or `both`), `events`, `dcs`. `book` and `missed_opps` read current state with the agent's §6 procedure and
 * stay on the agentic path. (The covered AEs' opps join `opps` when Settings has that list; it does not exist yet.)
 */
import { soqlRecords, Org62AutoRecorder } from '@/llm/org62-rec';
import { soqlDateTime } from '@/llm/skill-loader';

import type { CoverageObject } from '../types';
import { relayRead } from './slack';
import { ScopeFetchError, type FetchCall, type FetchRequest, type ScopeFetchResult } from './types';

export const ORG62_TOOL = 'soqlQuery';
export const ORG62_FTI_SCOPES = new Set(['opps', 'events', 'dcs']);

export interface SoqlQuery {
  ref: string;
  /** The query without its LIMIT; `{{page}}` marks where the paging filter goes. */
  base: string;
  limit: number;
  /** ORDER BY fields: the stamp and the id the paging filter compares. */
  stampField: string;
  idField: string;
}

/**
 * Ids per `AccountId IN (…)` clause. More accounts are more queries, never fewer accounts: 200 quoted 18-character
 * ids keep one statement near 4.5K characters, well inside SOQL's 100K-character statement limit and the relay's
 * argument size (an external limit; the split keeps every account).
 */
export const ORG62_IN_CHUNK = 200;

const OPP_FIELDS = 'Id, Name, AccountId, Account.Name, StageName, CloseDate, Amount, ForecastCategoryName, NextStep, Type, IsClosed, IsWon, OwnerId, SystemModstamp';

/** The scope's queries for the window (scan-org62 §2 verbatim), or null for a scope the agent reads. */
export function org62Queries(scope: string, window: { from: string; to: string }, vars: Record<string, unknown>, me: string | undefined): SoqlQuery[] | null {
  if (!ORG62_FTI_SCOPES.has(scope) || !me) return null;
  const f = soqlDateTime(window.from);
  const t = soqlDateTime(window.to);
  if (scope === 'opps') {
    const out: SoqlQuery[] = [
      {
        ref: 'soql:OpportunityTeamMember',
        base: `SELECT Id, OpportunityId, TeamMemberRole, SystemModstamp, Opportunity.Name, Opportunity.AccountId, Opportunity.Account.Name, Opportunity.StageName, Opportunity.CloseDate, Opportunity.Amount, Opportunity.ForecastCategoryName, Opportunity.NextStep, Opportunity.IsClosed, Opportunity.IsWon, Opportunity.SystemModstamp FROM OpportunityTeamMember WHERE UserId = '${me}' AND ((SystemModstamp >= ${f} AND SystemModstamp < ${t}) OR (Opportunity.SystemModstamp >= ${f} AND Opportunity.SystemModstamp < ${t})){{page}} ORDER BY Opportunity.SystemModstamp, OpportunityId`,
        limit: 50,
        stampField: 'Opportunity.SystemModstamp',
        idField: 'OpportunityId',
      },
    ];
    const ids = String(vars['org62.accountIds'] ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    for (let i = 0; i < ids.length; i += ORG62_IN_CHUNK) {
      const accounts = ids.slice(i, i + ORG62_IN_CHUNK).join(',');
      const ref = i === 0 ? 'soql:Opportunity:accounts' : `soql:Opportunity:accounts:${i / ORG62_IN_CHUNK + 1}`;
      out.push({ ref, base: `SELECT ${OPP_FIELDS.replace('OwnerId, ', 'OwnerId, Owner.Name, ')} FROM Opportunity WHERE AccountId IN (${accounts}) AND SystemModstamp >= ${f} AND SystemModstamp < ${t}{{page}} ORDER BY SystemModstamp, Id`, limit: 50, stampField: 'SystemModstamp', idField: 'Id' });
    }
    const book = String(vars['org62.book'] ?? 'team_member');
    if (book === 'owner' || book === 'both') out.push({ ref: 'soql:Opportunity:owned', base: `SELECT ${OPP_FIELDS} FROM Opportunity WHERE OwnerId = '${me}' AND SystemModstamp >= ${f} AND SystemModstamp < ${t}{{page}} ORDER BY SystemModstamp, Id`, limit: 50, stampField: 'SystemModstamp', idField: 'Id' });
    return out;
  }
  if (scope === 'events') {
    return [
      {
        ref: 'soql:Event',
        base: `SELECT Id, Subject, StartDateTime, EndDateTime, DurationInMinutes, Duration__c, SE_Task_Type__c, Meeting_Type__c, RecordType.Name, WhatId, What.Name, What.Type, AccountId, IsChild, Description, CreatedDate, SystemModstamp FROM Event WHERE OwnerId = '${me}' AND IsChild = false AND SystemModstamp >= ${f} AND SystemModstamp < ${t}{{page}} ORDER BY SystemModstamp, Id`,
        limit: 40,
        stampField: 'SystemModstamp',
        idField: 'Id',
      },
    ];
  }
  return [
    {
      ref: 'soql:Deal_Contribution__c',
      base: `SELECT Id, Opportunity__c, Opportunity__r.Name, Opportunity__r.AccountId, Opportunity__r.StageName, Opportunity__r.CloseDate, Opportunity__r.IsClosed, Opportunity__r.IsWon, SE_Name__c, Opportunity_Role__c, Split_Percentage__c, SystemModstamp FROM Deal_Contribution__c WHERE SE_Name__c = '${me}' AND SystemModstamp >= ${f} AND SystemModstamp < ${t}{{page}} ORDER BY SystemModstamp, Id`,
      limit: 100,
      stampField: 'SystemModstamp',
      idField: 'Id',
    },
  ];
}

const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** The query text for one page: the paging filter after `last`, and the LIMIT. */
export function soqlPage(q: SoqlQuery, limit: number, last?: { stamp: string; id: string }): string {
  const page = last ? ` AND (${q.stampField} > ${last.stamp} OR (${q.stampField} = ${last.stamp} AND ${q.idField} > '${escape(last.id)}'))` : '';
  return `${q.base.replace('{{page}}', page)} LIMIT ${limit}`;
}

const overflow = (text: string) => /exceed(?:s|ed)? (?:the )?max(?:imum)? (?:allowed )?tokens|too large|output (?:was )?truncated|response is too long/i.test(text);
const invalid = (text: string) => /MALFORMED_QUERY|INVALID_FIELD|INVALID_TYPE|INVALID_QUERY/.test(text);

/** The row's own place in its query's ORDER BY. */
function keyOf(q: SoqlQuery, r: Record<string, unknown>): { stamp: string; id: string } | null {
  if (q.idField === 'OpportunityId') {
    const o = (r.Opportunity ?? {}) as Record<string, unknown>;
    return typeof o.SystemModstamp === 'string' && typeof r.OpportunityId === 'string' ? { stamp: o.SystemModstamp, id: r.OpportunityId } : null;
  }
  return typeof r.SystemModstamp === 'string' && typeof r.Id === 'string' ? { stamp: r.SystemModstamp, id: r.Id } : null;
}

export async function fetchOrg62Scope(req: FetchRequest): Promise<ScopeFetchResult> {
  const queries = org62Queries(req.scope, req.window, req.vars, req.ctx.me.org62UserId);
  if (!queries) throw new ScopeFetchError(`org62 scope ${req.scope} has no fixed queries`, 'config', 'org62_scope', []);
  const backfill = req.mode === 'backfill' || req.mode === 'head' || req.mode === 'continuation';
  const maxPages = req.maxPages ?? (backfill ? 10 : 4);
  const rec = new Org62AutoRecorder(req.store, req.state);
  const calls: FetchCall[] = [];
  const coverage: CoverageObject[] = [];
  const stops: Array<{ stamp: string; id: string }> = [];
  const resume = (req.mode === 'continuation' || req.mode === 'retry') && /^\S+\|\S+$/.test(req.ctx.cursor?.value ?? '') ? { stamp: req.ctx.cursor!.value.split('|')[0]!, id: req.ctx.cursor!.value.split('|')[1]! } : undefined;
  let read = 0;
  for (const q of queries) {
    let last = resume;
    let limit = q.limit;
    let pages = 0;
    let full = false;
    while (pages < maxPages) {
      if (req.signal.aborted) throw new ScopeFetchError('aborted', 'transient', 'aborted', calls);
      const args = { q: soqlPage(q, limit, last) };
      const text = await relayRead(req, calls, ORG62_TOOL, args, (t) => soqlRecords(t)?.length ?? 0);
      const rows = soqlRecords(text);
      if (!rows) {
        if (invalid(text)) throw new ScopeFetchError(`org62 ${q.ref}: the query was refused`, 'config', 'soql_invalid', calls);
        if (overflow(text) && limit > 10) {
          limit = Math.max(10, Math.floor(limit / 2));
          continue;
        }
        throw new ScopeFetchError(`org62 ${q.ref}: no rows in the result`, 'transient', 'no_result', calls);
      }
      pages += 1;
      read += rows.length;
      await rec.onToolResult(ORG62_TOOL, args, text, `${q.ref}:p${pages}`);
      const tail = rows.length ? keyOf(q, rows[rows.length - 1]!) : null;
      full = rows.length >= limit && !!tail;
      if (!full) break;
      last = tail!;
    }
    if (full && last) {
      coverage.push({ kind: 'query_window', ref: q.ref, from: req.window.from, to: new Date(Date.parse(last.stamp.replace(/\+0000$/, 'Z'))).toISOString() });
      stops.push(last);
    } else coverage.push({ kind: 'query_window', ref: q.ref, from: req.window.from, to: req.window.to });
  }
  const at = (s: string) => new Date(Date.parse(s.replace(/\+0000$/, 'Z'))).toISOString();
  const first = stops.sort((a, b) => Date.parse(at(a.stamp)) - Date.parse(at(b.stamp)))[0];
  const cursor = first ? { value: `${first.stamp}|${first.id}`, at: at(first.stamp) } : { value: soqlDateTime(req.window.to), at: new Date(req.window.to).toISOString() };
  return { coverage, cursor, complete: !first, calls, read };
}
