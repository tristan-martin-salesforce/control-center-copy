/** Specialist Forecast (lane A: Time ▸ Forecast; persona feature specialistForecast). Never calls Org62. */
import type { In, Out } from './route';

export interface ForecastSource {
  getForecast(i: In<'getForecast'>): Out<'getForecast'>;
  getForecastRecord(i: In<'getForecastRecord'>): Out<'getForecastRecord'>;
  syncForecast(i: In<'syncForecast'>): Out<'syncForecast'>;
  draftForecastNotes(i: In<'draftForecastNotes'>): Out<'draftForecastNotes'>;
  patchForecast(i: In<'patchForecast'>): Out<'patchForecast'>;
  stageForecast(i: In<'stageForecast'>): Out<'stageForecast'>;
  checkMissingForecast(i: In<'checkMissingForecast'>): Out<'checkMissingForecast'>;
}
