/**
 * What a shared read view (R7 step 3) reads: the collections both DataSources hold, the settings, the meta and the
 * spend line. The db's ReadModel (datasource/db/model.ts, one page's scoped load) and the mock's Store
 * (datasource/mock/store.ts) both satisfy it, so one body serves both and parity-reads stays equal by construction.
 * A view never writes and never loads: the caller hands it the model it already has.
 */
import type { Settings, SpendSummary } from '@/contract';
import type { Collections } from '@/server/datasource/db/model';
import type { MetaState } from '@/server/datasource/db/store/settings';

export type ViewCollections = Collections;
export type ViewCollection = keyof ViewCollections;

export interface ReadSource {
  all<K extends ViewCollection>(col: K): ViewCollections[K][];
  get<K extends ViewCollection>(col: K, id: string): ViewCollections[K] | undefined;
  settings(): Settings;
  meta(): MetaState;
  spend(): SpendSummary;
}
