/**
 * Mock mode's "Search Org62": placeholder Opportunity records (fictional companies, fake 006XX ids, unique in their first 15 characters), so the picker's
 * Org62 search and "add it to the app" run end to end with nothing looked up. Tests reuse them as the soqlQuery
 * answer a fake read-only lookup returns on the db side.
 */
export interface MockOrg62Opp {
  Id: string;
  Name: string;
  AccountId: string;
  Account: { Name: string };
  StageName: string;
  CloseDate: string;
  Amount: number | null;
  ForecastCategoryName: string;
  Type: string;
  IsClosed: boolean;
  IsWon: boolean;
  Owner: { Name: string };
}

const opp = (n: number, name: string, account: string, acctN: number, stage: string, close: string, amount: number | null): MockOrg62Opp => ({
  Id: `006XX0000MOCK${String(n).padStart(2, '0')}AAA`,
  Name: name,
  AccountId: `001XX0000MOCK${String(acctN).padStart(2, '0')}AAA`,
  Account: { Name: account },
  StageName: stage,
  CloseDate: close,
  Amount: amount,
  ForecastCategoryName: 'Pipeline',
  Type: 'New Business',
  IsClosed: false,
  IsWon: false,
  Owner: { Name: 'Placeholder AE' },
});

/** The placeholder book Org62 "has" in mock mode: some on the seed's accounts, some on accounts the app lacks. */
export const MOCK_ORG62_OPPS: MockOrg62Opp[] = [
  opp(1, 'Globex · Service Cloud Voice', 'Globex', 1, 'Discovery', '2027-03-31', 180_000),
  opp(2, 'Initech · Agentforce SDR', 'Initech', 2, 'Qualification', '2027-02-15', 95_000),
  opp(3, 'Stark Labs · Data 360 Foundations', 'Stark Labs', 3, 'Discovery', '2027-04-30', 240_000),
  opp(4, 'Stark Labs · Agentforce Field Service', 'Stark Labs', 3, 'Qualification', '2027-06-30', null),
  opp(5, 'Wayne Logistics · Tableau Next Pilot', 'Wayne Logistics', 4, 'Solution Design', '2027-01-31', 120_000),
  opp(6, 'Hooli · Marketing Cloud Growth', 'Hooli', 5, 'Discovery', '2027-05-15', 60_000),
];

const words = (q: string) =>
  q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);

/** The records whose name or account name has every word of `q` (the db query is `Name LIKE … OR Account.Name LIKE …`). */
export function searchMockOrg62Opps(q: string, limit = 10): MockOrg62Opp[] {
  const ws = words(q);
  if (!ws.length) return [];
  return MOCK_ORG62_OPPS.filter((o) => {
    const hay = `${o.Name} ${o.Account.Name}`.toLowerCase();
    return ws.every((w) => hay.includes(w));
  })
    .sort((a, b) => b.CloseDate.localeCompare(a.CloseDate))
    .slice(0, limit);
}

/** The soqlQuery tool's answer for these records (what parseOrg62Rows reads). */
export const soqlAnswer = (records: MockOrg62Opp[]) => JSON.stringify({ totalSize: records.length, done: true, records });

/** The placeholder Org62 id of a seed opp (the seed has none): what mock logging batches and searches show. */
export const mockOrg62IdFor = (oppId: string) => `006XX${oppId.replace(/[^A-Za-z0-9]/g, '').slice(0, 10).padEnd(10, '0')}AAA`;
/** The placeholder Org62 Account id of a seed account (D-103 (c): an account target's WhatId in mock batches). */
export const mockOrg62AccountIdFor = (accountId: string) => `001XX${accountId.replace(/[^A-Za-z0-9]/g, '').slice(0, 10).padEnd(10, '0')}AAA`;
/** The app's id for a placeholder record once it is added (stable, so picking it twice reuses it). */
export const mockOppIdFor = (org62Id: string) => `opp_o62_${org62Id.slice(0, 15)}`;
export const mockAccountIdFor = (org62Id: string) => `acc_o62_${org62Id.slice(0, 15)}`;
