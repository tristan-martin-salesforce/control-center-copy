/**
 * The fixed, read-only SOQL of `forecast.sync` and its parsers. The model never writes SOQL: these builders take only
 * validated ids and quarter labels, and each query runs as ONE `soqlQuery` call through runOneReadLookup (the
 * scanners' Org62 read allowlist, src/llm/mcp-config.ts, not widened). Both shapes were checked read-only against
 * Org62 on 2026-11-11 (a placeholder owner, zero rows).
 *
 *   records  my SpecialistForecast__c for this and next fiscal quarter, 25 per page (keyset on Id), with the core
 *            opp's name, account, stage, next step and close date
 *   history  the newest ForecastNotes__c change per record (there is no notes-updated field; the long-text field's
 *            history keeps no values, so the previous note comes from the mirror)
 *   one opp  my records on ONE core opportunity in the same window ("I created it, check now"; the same fields and
 *            filters as `records` plus `Opportunity__c = <id>`; not yet run against Org62, see B-100)
 */
import { redactText } from '@/llm/redact';

export const SFR_PAGE = 25;
/**
 * A runaway guard only (caps audit 2026-11-21: was 8 pages, so a book past 200 records was read in part every sync):
 * the sync pages until Org62 has no more, and stops here (10,000 records) or when a page's last id does not advance,
 * reporting a partial read.
 */
export const SFR_MAX_PAGES = 400;

export const SFR_FIELDS = [
  'Id',
  'Name',
  'Opportunity__c',
  'Opportunity__r.Name',
  'Opportunity__r.AccountId',
  'Opportunity__r.Account.Name',
  'Opportunity__r.StageName',
  'Opportunity__r.NextStep',
  'Opportunity__r.CloseDate',
  'ForecastNotes__c',
  'MgrForecastNotes__c',
  'Deal_Role__c',
  'Management_Forecast_Judgement__c',
  'ForecastStatus__c',
  'ForecastAmount__c',
  'ForecastStage__c',
  'ForecastCloseDate__c',
  'FiscalQuarter__c',
  'OwnerId',
  'LastModifiedDate',
] as const;

const USER_ID = /^005[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;
/** An Org62 Opportunity id (15 or 18 characters). */
export const OPP_ID = /^006[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;
const RECORD_ID = /^[A-Za-z0-9]{15,18}$/;
const QUARTER = /^FY\d{2} Q[1-4]$/;

export class ForecastSoqlError extends Error {}

function guard(owner: string, quarters: readonly string[]) {
  if (!USER_ID.test(owner)) throw new ForecastSoqlError('not an Org62 user id');
  if (!quarters.length || quarters.some((q) => !QUARTER.test(q))) throw new ForecastSoqlError('not a fiscal quarter label (FY27 Q4)');
}

const inList = (qs: readonly string[]) => `(${qs.map((q) => `'${q}'`).join(', ')})`;

/** One page of my records; `after` = the last Id of the previous page. */
export function sfrRecordsSoql(owner: string, quarters: readonly string[], after: string | null = null): string {
  guard(owner, quarters);
  if (after !== null && !RECORD_ID.test(after)) throw new ForecastSoqlError('not a record id');
  return `SELECT ${SFR_FIELDS.join(', ')} FROM SpecialistForecast__c WHERE OwnerId = '${owner}' AND FiscalQuarter__c IN ${inList(quarters)}${after ? ` AND Id > '${after}'` : ''} ORDER BY Id LIMIT ${SFR_PAGE}`;
}

/** My records on one core opportunity, in the same window ("I created it, check now": at most one page). */
export function sfrRecordsForOppSoql(owner: string, quarters: readonly string[], oppId: string): string {
  guard(owner, quarters);
  if (!OPP_ID.test(oppId)) throw new ForecastSoqlError('not an Org62 opportunity id');
  return `SELECT ${SFR_FIELDS.join(', ')} FROM SpecialistForecast__c WHERE OwnerId = '${owner}' AND Opportunity__c = '${oppId}' AND FiscalQuarter__c IN ${inList(quarters)} ORDER BY Id LIMIT ${SFR_PAGE}`;
}

/** The newest ForecastNotes__c change per record of mine in the same window. */
export function sfrNotesHistorySoql(owner: string, quarters: readonly string[]): string {
  guard(owner, quarters);
  return `SELECT ParentId, MAX(CreatedDate) lastAt FROM SpecialistForecast__History WHERE Field = 'ForecastNotes__c' AND ParentId IN (SELECT Id FROM SpecialistForecast__c WHERE OwnerId = '${owner}' AND FiscalQuarter__c IN ${inList(quarters)}) GROUP BY ParentId LIMIT 2000`;
}

/** One record as Org62 returned it (long text redacted of credential-like strings). */
export interface Org62Sfr {
  org62Id: string;
  name: string;
  org62OpportunityId: string | null;
  opportunityName: string | null;
  org62AccountId: string | null;
  accountName: string | null;
  oppStage: string | null;
  oppNextStep: string | null;
  oppCloseDate: string | null;
  notes: string | null;
  mgrNotes: string | null;
  dealRole: string | null;
  judgement: string | null;
  forecastStatus: string | null;
  amount: number | null;
  stage: string | null;
  closeDate: string | null;
  fiscalQuarter: string | null;
  ownerOrg62Id: string | null;
  lastModifiedAt: string | null;
}

export class ForecastParseError extends Error {}

function body(raw: string): { records?: Array<Record<string, unknown>>; done?: boolean } {
  const t = raw.trim();
  const at = t.indexOf('{');
  if (at < 0) throw new ForecastParseError('Org62 answered in a way the app could not read');
  try {
    return JSON.parse(t.slice(at)) as { records?: Array<Record<string, unknown>> };
  } catch {
    throw new ForecastParseError('Org62 answered in a way the app could not read');
  }
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
const text = (v: unknown, max: number) => {
  const s = str(v);
  return s ? redactText(s).slice(0, max) : null;
};
const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/** Org62's `2026-11-10T17:55:27.000+0000` → an ISO instant; null when unreadable. */
export function sfInstantToIso(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const fixed = v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(fixed);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** A records page → rows (only well-formed record ids). */
export function parseSfrRecords(raw: string): Org62Sfr[] {
  return (body(raw).records ?? [])
    .filter((r) => typeof r.Id === 'string' && RECORD_ID.test(r.Id))
    .map((r) => {
      const opp = (r.Opportunity__r ?? null) as Record<string, unknown> | null;
      const acc = (opp?.Account ?? null) as Record<string, unknown> | null;
      const amt = r.ForecastAmount__c;
      return {
        org62Id: r.Id as string,
        name: str(r.Name) ?? (r.Id as string),
        org62OpportunityId: str(r.Opportunity__c),
        opportunityName: str(opp?.Name),
        org62AccountId: str(opp?.AccountId),
        accountName: str(acc?.Name),
        oppStage: str(opp?.StageName),
        oppNextStep: text(opp?.NextStep, 1000),
        oppCloseDate: day(opp?.CloseDate),
        notes: text(r.ForecastNotes__c, 32_768),
        mgrNotes: text(r.MgrForecastNotes__c, 32_768),
        dealRole: str(r.Deal_Role__c),
        judgement: str(r.Management_Forecast_Judgement__c),
        forecastStatus: str(r.ForecastStatus__c),
        amount: typeof amt === 'number' && Number.isFinite(amt) ? amt : null,
        stage: str(r.ForecastStage__c),
        closeDate: day(r.ForecastCloseDate__c),
        fiscalQuarter: str(r.FiscalQuarter__c),
        ownerOrg62Id: str(r.OwnerId),
        lastModifiedAt: sfInstantToIso(r.LastModifiedDate),
      };
    });
}

/** The history aggregate → record Id → the newest ForecastNotes__c change (ISO). */
export function parseNotesHistory(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of body(raw).records ?? []) {
    const id = r.ParentId;
    const at = sfInstantToIso(r.lastAt ?? r.expr0);
    if (typeof id !== 'string' || !RECORD_ID.test(id) || !at) continue;
    const cur = out.get(id);
    if (!cur || cur < at) out.set(id, at);
  }
  return out;
}
