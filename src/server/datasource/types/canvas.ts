/** Logging canvases: batches, landings (D-70) and review (2026-11-13 audit B2). */
import type { In, Out } from './route';

export interface CanvasSource {
  stageLogBatch(i: In<'stageLogBatch'>): Out<'stageLogBatch'>;
  /** D-70 landings (src/lib/landings): a run's writes, a record's landings, Event updates, use cases in both systems. */
  getCanvasWrites(i: In<'getCanvasWrites'>): Out<'getCanvasWrites'>;
  getRecordLandings(i: In<'getRecordLandings'>): Out<'getRecordLandings'>;
  getEventUpdates(i: In<'getEventUpdates'>): Out<'getEventUpdates'>;
  proposeEventUpdates(i: In<'proposeEventUpdates'>): Out<'proposeEventUpdates'>;
  patchEventUpdate(i: In<'patchEventUpdate'>): Out<'patchEventUpdate'>;
  getUseCaseLandings(i: In<'getUseCaseLandings'>): Out<'getUseCaseLandings'>;
  pickUseCaseValue(i: In<'pickUseCaseValue'>): Out<'pickUseCaseValue'>;
  fixUseCase(i: In<'fixUseCase'>): Out<'fixUseCase'>;
  /** 2026-11-13 audit B2: a canvas item's rows by kind, and Remove / Edit before Apply (src/server/time/canvas-review.ts). */
  getCanvasReview(i: In<'getCanvasReview'>): Out<'getCanvasReview'>;
  removeCanvasRows(i: In<'removeCanvasRows'>): Out<'removeCanvasRows'>;
  editCanvasRow(i: In<'editCanvasRow'>): Out<'editCanvasRow'>;
}
