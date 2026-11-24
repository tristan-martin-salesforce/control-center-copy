/** PLACEHOLDER deal fixtures (ACME / Globex / Initech). No real names, ids or amounts. */
import type { AccountScope, DcRecord, LineItemRecord, OppRecord } from '@/engines/deals/types';

export const ME = { userId: '005PLACEHOLDER0001', name: 'Test User' };
export const OTHER_SE = '005PLACEHOLDER0002';
export const A_ACME = '001PLACEHOLDER0001';
export const A_GLOBEX = '001PLACEHOLDER0002';
export const A_INITECH = '001PLACEHOLDER0003';
export const A_UNKNOWN = '001PLACEHOLDER0009';

export const opp = (p: Partial<OppRecord> & Pick<OppRecord, 'id' | 'name' | 'accountId'>): OppRecord => ({
  accountName: p.accountId === A_ACME ? 'ACME Health' : p.accountId === A_GLOBEX ? 'Globex Corp' : 'Initech Inc',
  amount: 100_000,
  stageName: '02 - Determining Problem',
  isClosed: false,
  isWon: false,
  closeDate: '2027-03-31',
  type: 'New Business',
  deadlineToUpdate: '2027-02-03',
  ...p,
});

export const line = (oppId: string, productName: string, totalPrice: number): LineItemRecord => ({ oppId, productName, totalPrice });

export const dc = (p: Partial<DcRecord> & Pick<DcRecord, 'id' | 'oppId'>): DcRecord => ({ userId: OTHER_SE, userName: 'Other SE', role: 'AI + Data Architect', splitPercent: 100, ...p });

export const CORE: AccountScope = { accountId: A_ACME, kind: 'core', via: ['opp_team'] };
export const CORE2: AccountScope = { accountId: A_GLOBEX, kind: 'core', via: ['org62_event'] };
export const LIGHT: AccountScope = { accountId: A_INITECH, kind: 'light', via: ['calendar'] };

export const WINDOW = { start: '2026-11-01', end: '2027-01-31' };
export const TODAY = '2026-11-05';
