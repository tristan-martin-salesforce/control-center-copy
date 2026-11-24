/** W0-1: a Slack/Org62 sign-in failure that looks like the scanners' settingSources change (src/ops/scanner-auth.ts). */
import { readScannerAuth, scannerAuthPath, SETTINGS_SOURCES_CODE, settingsSourcesMessage, settingsSourcesSuspect } from '../scanner-auth';
import { bad, ok, type Check } from './types';

export const checkSettingsSources: Check = async (c) => {
  const label = 'Scanner settings sources';
  const s = settingsSourcesSuspect(readScannerAuth(scannerAuthPath(c.env)), c.env);
  if (!s) return ok('settings-sources', label, (c.env.CC_SCANNER_SETTING_SOURCES ?? '').trim() ? `scanners load: ${c.env.CC_SCANNER_SETTING_SOURCES}` : 'scanners load no settings files; no sign-in failure points at it');
  return bad('warn', 'settings-sources', label, settingsSourcesMessage(s), 'add CC_SCANNER_SETTING_SOURCES=user to the env file, then launchctl kickstart -k gui/$UID/com.commandcenter.worker', { connector: s.connector, why: s.why, failed: s.code }, { code: SETTINGS_SOURCES_CODE });
};
