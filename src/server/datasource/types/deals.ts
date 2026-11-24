/** Deals, accounts, missed opps and DC requests. */
import type { In, Out } from './route';

export interface DealsSource {
  getDeals(i: In<'getDeals'>): Out<'getDeals'>;
  getMissed(i: In<'getMissed'>): Out<'getMissed'>;
  getAccount(i: In<'getAccount'>): Out<'getAccount'>;
  /** D-58: Deal Contribution requests (the DCs to claim on the next logging canvas, with where each one is). */
  getUseCaseSync(i: In<'getUseCaseSync'>): Out<'getUseCaseSync'>;
  listDcRequests(i: In<'listDcRequests'>): Out<'listDcRequests'>;
  /** D-58: claim a DC on an opportunity the app has (app id or Org62 id); approved, audited + undoable; nothing is sent. */
  addOrg62Opps(i: In<'addOrg62Opps'>): Out<'addOrg62Opps'>;
  createDcRequest(i: In<'createDcRequest'>): Out<'createDcRequest'>;
  /** Edit a DC request still waiting for a canvas (re-checked against my DC); refused once on a canvas, with why. */
  patchDcRequest(i: In<'patchDcRequest'>): Out<'patchDcRequest'>;
  /** Withdraw a DC request still waiting for a canvas; refused once on a canvas, with why. */
  withdrawDcRequest(i: In<'withdrawDcRequest'>): Out<'withdrawDcRequest'>;
  /** 2026-11-13 audit C7: withdraw several waiting DC requests in one change set (one Undo); the others are skipped, with why. */
  withdrawDcRequests(i: In<'withdrawDcRequests'>): Out<'withdrawDcRequests'>;
  /** One Claim verb: a DC request on the finding's opp (a task only when the app doesn't know the opp). */
  claimMissed(i: In<'claimMissed'>): Out<'claimMissed'>;
  dismissMissed(i: In<'dismissMissed'>): Out<'dismissMissed'>;
}
