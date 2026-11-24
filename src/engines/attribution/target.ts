/**
 * D-103 (c): what a Time row logs to, and why, in one sentence (the "groundwork"). Pure, computed from facts and
 * never from a model, so the mock and the db say the same sentence about the same row.
 *
 *   accountTargetWhat   the ONE function that decides the WhatId of an account target. Today a Solutions Event on
 *                       the Account (WhatId `001…`), the only mechanism the repo knows. B-117 (confirm with SE Ops)
 *                       is open: if post-sale time logs some other way, it changes here and nowhere else.
 *   groundworkOf        the sentence: no open opportunity (the account), the account's only open one, the pick among
 *                       several (with my hours there this month), learned from my pick, or internal.
 *
 * Hours never split across opps (EDGE-CASES rule 1): the target is one opp, one account, or nothing.
 */
import type { ActivityEntry, Groundwork } from '@/contract';

/** An Org62 Account id (15 or 18 characters, prefix 001). */
export const ORG62_ACCOUNT_ID = /^001[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;

/** The Account id in an Org62 record URL (`…/Account/001…/view`), or null. */
export function org62AccountIdOfUrl(url: string | null | undefined): string | null {
  const m = url ? /\/(001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)(?:\/|$)/.exec(url) : null;
  return m ? m[1]! : null;
}

/**
 * The WhatId an account target logs with (B-117: swappable here). Null when the account has no Org62 id: the row then
 * cannot go on a batch until it has one (it says so, like a missing opportunity).
 */
export function accountTargetWhat(org62AccountId: string | null | undefined): { whatType: 'Account'; whatId: string } | null {
  return org62AccountId && ORG62_ACCOUNT_ID.test(org62AccountId) ? { whatType: 'Account', whatId: org62AccountId } : null;
}

export interface GroundworkFacts {
  /** The account's name ("Acme"). */
  accountName: string;
  /** Open opportunities on the account (id and name). */
  openOpps: ReadonlyArray<{ id: string; name: string }>;
  /** The opportunity the row logs to (or is suggested), when there is one. */
  pickedOppId?: string | null;
  /** My hours on the picked opp this month (approved and later rows). */
  hoursThisMonth?: number;
  /** A learned rule picked it: the day I made that pick (YYYY-MM-DD). */
  learnedOn?: string | null;
}

const fmtDay = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtH = (h: number) => `${Math.round(h * 4) / 4} h`;

/** The sentence for a row's target from its facts (see the module comment). */
export function groundworkOf(f: GroundworkFacts): Groundwork {
  if (f.learnedOn) return { code: 'rule', text: `Learned ${fmtDay(f.learnedOn)} from your pick.` };
  if (!f.openOpps.length) return { code: 'account_no_open_opp', text: `No open opportunity on ${f.accountName}, so I tied it to the account.` };
  const picked = f.pickedOppId ? f.openOpps.find((o) => o.id === f.pickedOppId) : undefined;
  if (f.openOpps.length === 1 && (!f.pickedOppId || picked)) return { code: 'opp_single', text: `${f.accountName}’s only open opportunity.` };
  const n = f.openOpps.length;
  if (!picked) return { code: 'opp_pick', text: `${n} open opps could take this; pick the one it was for.` };
  const hours = f.hoursThisMonth && f.hoursThisMonth > 0 ? ` (you logged ${fmtH(f.hoursThisMonth)} there this month)` : '';
  return { code: 'opp_pick', text: `${n} open opps could take this; I think ${picked.name}${hours}.` };
}

const INTERNAL: Groundwork = { code: 'internal', text: 'Internal work: no customer.' };
const LOGGED = new Set<ActivityEntry['status']>(['approved', 'synced_to_canvas', 'logged', 'verified', 'verify_failed']);

export interface GroundworkIndex {
  account: (id: string) => { id: string; name: string } | null;
  accountByName: (name: string) => { id: string; name: string } | null;
  opp: (id: string) => { id: string; name: string; accountId: string | null } | null;
  openOppsOf: (accountId: string) => ReadonlyArray<{ id: string; name: string }>;
  hoursThisMonth: (oppId: string, day: string) => number;
}

/** The facts a set of rows needs, indexed once (the row list is read many times per page). */
export function groundworkIndex(ctx: { opps: ReadonlyArray<{ id: string; name: string; accountId: string; isOpen: boolean }>; accounts: ReadonlyArray<{ id: string; name: string }>; activity: readonly ActivityEntry[] }): GroundworkIndex {
  const accounts = new Map(ctx.accounts.map((a) => [a.id, a] as const));
  const byName = new Map(ctx.accounts.map((a) => [a.name.trim().toLowerCase(), a] as const));
  const opps = new Map(ctx.opps.map((o) => [o.id, o] as const));
  const open = new Map<string, Array<{ id: string; name: string }>>();
  for (const o of ctx.opps) if (o.isOpen && o.accountId) open.set(o.accountId, [...(open.get(o.accountId) ?? []), { id: o.id, name: o.name }]);
  const hours = new Map<string, number>();
  for (const a of ctx.activity) if (a.oppId && LOGGED.has(a.status)) hours.set(`${a.oppId}|${a.date.slice(0, 7)}`, (hours.get(`${a.oppId}|${a.date.slice(0, 7)}`) ?? 0) + a.durationH);
  return {
    account: (id) => accounts.get(id) ?? null,
    accountByName: (n) => byName.get(n.trim().toLowerCase()) ?? null,
    opp: (id) => opps.get(id) ?? null,
    openOppsOf: (id) => open.get(id) ?? [],
    hoursThisMonth: (oppId, day) => hours.get(`${oppId}|${day.slice(0, 7)}`) ?? 0,
  };
}

/**
 * A row's sentence: internal work; its opportunity (only one open, or the pick among several); its account with no
 * open opportunity; or, while it still needs one, the suggestion's (`suggestedOppId`, `learnedOn` when a learned rule
 * made it). Null when the row has no account to speak of.
 */
export function rowGroundwork(e: ActivityEntry, ix: GroundworkIndex, s: { suggestedOppId?: string | null; learnedOn?: string | null } = {}): Groundwork | null {
  if (e.internal) return INTERNAL;
  if (e.fromOrg62) return null;
  const oppId = e.oppId ?? s.suggestedOppId ?? null;
  const opp = oppId ? ix.opp(oppId) : null;
  const acct = (e.accountId ? ix.account(e.accountId) : null) ?? (opp?.accountId ? ix.account(opp.accountId) : null) ?? (e.accountName ? ix.accountByName(e.accountName) : null);
  if (!acct) return null;
  // a row on a closed opportunity: nothing to explain about open ones
  if (e.oppId && !ix.openOppsOf(acct.id).some((o) => o.id === e.oppId)) return null;
  // the account itself, picked on purpose though it has open opps: say both facts
  const open = ix.openOppsOf(acct.id);
  if (e.accountId && !e.oppId && open.length) return { code: 'opp_pick', text: `Logs to ${acct.name} itself, as you picked; ${open.length === 1 ? '1 open opp' : `${open.length} open opps`} there could take it.` };
  return groundworkOf({ accountName: acct.name, openOpps: ix.openOppsOf(acct.id), pickedOppId: opp?.id ?? null, hoursThisMonth: opp ? ix.hoursThisMonth(opp.id, e.date) : 0, learnedOn: e.oppId ? null : (s.learnedOn ?? null) });
}
