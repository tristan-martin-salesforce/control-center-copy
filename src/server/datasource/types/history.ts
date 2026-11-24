/** History (B-081): what was done on past days, from stored history only. */
import type { In, Out } from './route';

export interface HistorySource {
  getHistoryMonth(i: In<'getHistoryMonth'>): Out<'getHistoryMonth'>;
  getHistoryDay(i: In<'getHistoryDay'>): Out<'getHistoryDay'>;
}
