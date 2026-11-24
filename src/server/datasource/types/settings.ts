/** Settings, retention and policy. */
import type { In, Out } from './route';

export interface SettingsSource {
  getSettings(i: In<'getSettings'>): Out<'getSettings'>;
  patchSettings(i: In<'patchSettings'>): Out<'patchSettings'>;
  raiseBudgetToday(i: In<'raiseBudgetToday'>): Out<'raiseBudgetToday'>;
  getRetention(i: In<'getRetention'>): Out<'getRetention'>;
  patchRetention(i: In<'patchRetention'>): Out<'patchRetention'>;
  runRetention(i: In<'runRetention'>): Out<'runRetention'>;
  previewPolicy(i: In<'previewPolicy'>): Out<'previewPolicy'>;
  applyPolicy(i: In<'applyPolicy'>): Out<'applyPolicy'>;
  revertPolicy(i: In<'revertPolicy'>): Out<'revertPolicy'>;
  getPolicyVersions(i: In<'getPolicyVersions'>): Out<'getPolicyVersions'>;
}
