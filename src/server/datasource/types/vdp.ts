/** VDP (read-only mirror; changes are Outbox items). */
import type { In, Out } from './route';

export interface VdpSource {
  /** VDP coverage + gaps from the read-only mirror (vdp_records); the mock serves placeholder VDPs. Never calls VDP. */
  getVdpCoverage(i: In<'getVdpCoverage'>): Out<'getVdpCoverage'>;
  /** One VDP or one account not in VDP yet: steps, asset candidates, everything the mirror read. Never calls VDP. */
  getVdpDetail(i: In<'getVdpDetail'>): Out<'getVdpDetail'>;
  /** Confirm / mark added / dismiss an asset candidate (local state; VDP is never written). */
  setVdpCandidate(i: In<'setVdpCandidate'>): Out<'setVdpCandidate'>;
  /** Queue read-only research runs that look for a VDP's assets (db: the worker; mock: placeholder candidates). */
  findVdpAssets(i: In<'findVdpAssets'>): Out<'findVdpAssets'>;
  /** One VDP field change as an Outbox item (status `ready`, mode `send` = Apply). Never calls VDP. */
  draftVdpUpdate(i: In<'draftVdpUpdate'>): Out<'draftVdpUpdate'>;
  /** D-60: "Push N to VDP": each ticked item staged and applied on the user's click (dry run records only). */
  pushVdpChanges(i: In<'pushVdpChanges'>): Out<'pushVdpChanges'>;
  /** D-69: search VDP companies for Change… (read-only: the mirror, stored lookups, VDP itself when live). */
  searchVdpCompanies(i: In<'searchVdpCompanies'>): Out<'searchVdpCompanies'>;
  /** D-69: your company mapping for a node (user-locked, undoable, local). */
  setVdpIdentity(i: In<'setVdpIdentity'>): Out<'setVdpIdentity'>;
  /** D-69: reset a node to the app's own decision. */
  clearVdpIdentity(i: In<'clearVdpIdentity'>): Out<'clearVdpIdentity'>;
}
