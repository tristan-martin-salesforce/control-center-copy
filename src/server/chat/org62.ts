/**
 * `search source org62` (BE-CHAT): a live, read-only Org62 search for opportunities or accounts. The model never writes
 * SOQL: it passes words, this module builds one SELECT from fixed fields (no long-text bodies), and the query runs as
 * ONE `soqlQuery` call through runOneReadLookup (the scanners' read-only allowlist, not widened). Rows are matched to
 * the app's own opportunities and accounts so a follow-up change (edit_activities) can use their ids.
 */
import { z } from 'zod';

import { myDcWords } from '@/contract/deals';

export const Org62LookupInput = z.object({
  find: z.enum(['opportunities', 'accounts']),
  /** Words in the opportunity (or account) name. */
  name: z.string().max(80).optional(),
  /** Words in the account name (opportunities only). */
  account: z.string().max(80).optional(),
  /** Opportunities: open only (default true). */
  openOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type Org62LookupInput = z.infer<typeof Org62LookupInput>;

export interface Org62Row {
  org62Id: string;
  name: string;
  account: string | null;
  accountOrg62Id: string | null;
  stage?: string | null;
  closeDate?: string | null;
  amount?: number | null;
  forecast?: string | null;
  type?: string | null;
  open?: boolean;
  won?: boolean;
  owner: string | null;
  /**
   * The same record in the app (ids usable in chat changes), when the app has it. `onMyTeam` is the opp team only;
   * `myDc` is my Deal Contribution on it (split, role), or null: holding a DC is not being on the team.
   */
  inApp?: { oppId?: string; accountId?: string; onMyTeam?: boolean; myDc?: { split: number | null; role: string | null } | null; dcWords?: string | null };
}

export interface Org62LookupResult {
  soql: string;
  rows: Org62Row[];
  notes: string[];
  costUsd: number;
}

export class Org62LookupError extends Error {}

/** A LIKE literal: letters, digits and a few name characters only; quotes and backslashes escaped. */
export function soqlLike(words: string): string {
  const t = words
    .replace(/[^\p{L}\p{N} &.,'()/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length < 2) throw new Org62LookupError('give at least 2 letters of a name');
  return `'%${t.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}%'`;
}

const OPP_FIELDS = 'Id, Name, AccountId, Account.Name, StageName, CloseDate, Amount, ForecastCategoryName, Type, IsClosed, IsWon, Owner.Name';

export function buildOrg62Query(i: Org62LookupInput): string {
  const limit = Math.max(1, Math.min(200, i.limit ?? 10));
  if (i.find === 'accounts') {
    if (!i.name) throw new Org62LookupError('accounts: pass name');
    return `SELECT Id, Name, Type, Owner.Name FROM Account WHERE Name LIKE ${soqlLike(i.name)} ORDER BY Name LIMIT ${limit}`;
  }
  const where: string[] = [];
  if (i.account) where.push(`Account.Name LIKE ${soqlLike(i.account)}`);
  if (i.name) where.push(`Name LIKE ${soqlLike(i.name)}`);
  if (!where.length) throw new Org62LookupError('opportunities: pass account and/or name');
  if (i.openOnly !== false) where.push('IsClosed = false');
  // Newest close date first: stale opportunities nobody closed (years-old "open" rows) must not crowd out current ones.
  return `SELECT ${OPP_FIELDS} FROM Opportunity WHERE ${where.join(' AND ')} ORDER BY CloseDate DESC NULLS LAST LIMIT ${limit}`;
}

/**
 * The Time picker's "Search Org62 for '…'": open opportunities with every typed word in their own or their account's
 * name (at most 4 words), newest close date first. Same fields, tool and parsing as the Assistant's lookup.
 */
export function buildOrg62OppSearch(q: string, limit = 10): string {
  const ws = q
    .split(/[^\p{L}\p{N}&.'()/-]+/u)
    .filter((w) => w.length >= 2)
    .slice(0, 4);
  if (!ws.length) throw new Org62LookupError('give at least 2 letters of a name');
  const where = ws.map((w) => `(Name LIKE ${soqlLike(w)} OR Account.Name LIKE ${soqlLike(w)})`);
  where.push('IsClosed = false');
  return `SELECT ${OPP_FIELDS} FROM Opportunity WHERE ${where.join(' AND ')} ORDER BY CloseDate DESC NULLS LAST LIMIT ${Math.max(1, Math.min(25, limit))}`;
}

/**
 * D-103 (c): the picker's accounts for the same words: every typed word in the Account name (at most 4 words), by
 * name. One more fixed SELECT on the same read-only soqlQuery (the allowlist is not widened); bound words only.
 */
export function buildOrg62AccountSearch(q: string, limit = 5): string {
  const ws = q
    .split(/[^\p{L}\p{N}&.'()/-]+/u)
    .filter((w) => w.length >= 2)
    .slice(0, 4);
  if (!ws.length) throw new Org62LookupError('give at least 2 letters of a name');
  return `SELECT Id, Name, Type, Owner.Name FROM Account WHERE ${ws.map((w) => `Name LIKE ${soqlLike(w)}`).join(' AND ')} ORDER BY Name LIMIT ${Math.max(1, Math.min(10, limit))}`;
}

const OPP_ID = /^006[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/;

/** One Opportunity by its Org62 id (adding a picked hit to the app reads the record itself, not the client's copy). */
export function buildOrg62OppById(id: string): string {
  if (!OPP_ID.test(id)) throw new Org62LookupError('not an Opportunity id');
  return `SELECT ${OPP_FIELDS} FROM Opportunity WHERE Id = '${id}' LIMIT 1`;
}

/** At most this many ids in one by-id read (addOrg62Opps). */
export const ORG62_OPPS_BY_IDS_MAX = 100;

/** Several Opportunities by Org62 id in one SELECT (adding untracked opps to the app, e.g. to claim DCs on them). */
export function buildOrg62OppsByIds(ids: readonly string[]): string {
  const uniq = [...new Set(ids.map((i) => i.trim()))];
  if (!uniq.length || uniq.length > ORG62_OPPS_BY_IDS_MAX) throw new Org62LookupError(`give 1 to ${ORG62_OPPS_BY_IDS_MAX} Opportunity ids`);
  const bad = uniq.find((i) => !OPP_ID.test(i));
  if (bad) throw new Org62LookupError(`not an Opportunity id: ${bad.slice(0, 20)}`);
  return `SELECT ${OPP_FIELDS} FROM Opportunity WHERE Id IN (${uniq.map((i) => `'${i}'`).join(', ')}) LIMIT ${uniq.length}`;
}

type Rec = Record<string, unknown> & {
  Account?: { Name?: unknown } | null;
  Owner?: { Name?: unknown } | null;
};
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const ORG62_ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

/** The soqlQuery output (`{records: [...]}`, possibly after a text prefix) → rows. */
export function parseOrg62Rows(raw: string, find: Org62LookupInput['find']): Org62Row[] {
  let body: { records?: Rec[] };
  try {
    const t = raw.trim();
    body = JSON.parse(t.slice(t.indexOf('{'))) as typeof body;
  } catch {
    throw new Org62LookupError('Org62 answered in a way the app could not read');
  }
  return (body.records ?? [])
    .filter((r) => typeof r.Id === 'string' && ORG62_ID.test(r.Id))
    .map((r): Org62Row =>
      find === 'accounts'
        ? {
            org62Id: r.Id as string,
            name: str(r.Name) ?? '',
            account: null,
            accountOrg62Id: r.Id as string,
            type: str(r.Type),
            owner: str(r.Owner?.Name),
          }
        : {
            org62Id: r.Id as string,
            name: str(r.Name) ?? '',
            account: str(r.Account?.Name),
            accountOrg62Id: str(r.AccountId),
            stage: str(r.StageName),
            closeDate: str(r.CloseDate),
            amount: typeof r.Amount === 'number' ? r.Amount : null,
            forecast: str(r.ForecastCategoryName),
            type: str(r.Type),
            open: r.IsClosed !== true,
            won: r.IsWon === true,
            owner: str(r.Owner?.Name),
          },
    );
}

/** Attach the app's ids: an Org62 id appears in the record's org62Url. */
export function matchInApp(
  rows: Org62Row[],
  opps: Array<{
    id: string;
    accountId: string;
    org62Url: string | null;
    isMine: boolean;
    myDc?: { split: number | null; role: string | null } | null;
    dcAssigned?: boolean;
  }>,
  accounts: Array<{ id: string; org62Url: string | null }>,
): Org62Row[] {
  const key = (url: string | null) => (url ? (/\/(\w{15,18})(?:\/|$)/.exec(url)?.[1] ?? '').slice(0, 15) : '');
  const oppBy = new Map(opps.map((o) => [key(o.org62Url), o] as const).filter(([k]) => k));
  const acctBy = new Map(accounts.map((a) => [key(a.org62Url), a] as const).filter(([k]) => k));
  return rows.map((r) => {
    const o = oppBy.get(r.org62Id.slice(0, 15));
    const a = r.accountOrg62Id ? acctBy.get(r.accountOrg62Id.slice(0, 15)) : undefined;
    const accountId = a?.id ?? o?.accountId;
    const inApp = {
      ...(o ? { oppId: o.id, onMyTeam: o.isMine, myDc: o.myDc ? { split: o.myDc.split, role: o.myDc.role } : null, dcWords: myDcWords(o.myDc) ?? (o.dcAssigned ? 'Your DC: split not read yet' : 'No DC from you') } : {}),
      ...(accountId ? { accountId } : {}),
    };
    return Object.keys(inApp).length ? { ...r, inApp } : r;
  });
}

/** An Org62 Account row → the Time picker's account hit (D-103 (c): picking it logs the row to the account). */
export function org62AccountHit(r: Org62Row) {
  return {
    kind: 'account' as const,
    org62Id: r.org62Id,
    name: r.name,
    accountName: r.name,
    accountOrg62Id: r.org62Id,
    stage: null,
    closeDate: null,
    amount: null,
    owner: r.owner,
    isOpen: true,
    oppId: null,
    accountId: r.inApp?.accountId ?? null,
  };
}

/** An Org62 row → the Time picker's hit (the app's own ids when it has the record). */
export function org62OppHit(r: Org62Row) {
  return {
    kind: 'opp' as const,
    org62Id: r.org62Id,
    name: r.name,
    accountName: r.account,
    accountOrg62Id: r.accountOrg62Id,
    stage: r.stage ?? null,
    closeDate: r.closeDate && /^\d{4}-\d{2}-\d{2}$/.test(r.closeDate) ? r.closeDate : null,
    amount: r.amount ?? null,
    owner: r.owner,
    isOpen: r.open !== false,
    oppId: r.inApp?.oppId ?? null,
    accountId: r.inApp?.accountId ?? null,
  };
}
