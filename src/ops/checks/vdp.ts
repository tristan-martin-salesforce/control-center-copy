/**
 * VDP access (the SE persona's feature): the vdp-app-fir entry, its PAT (presence only, never read out), the Okta
 * cookie's expiry and the refresh script (AUTH.VDP.*, DEP.VDP.NO_SCRIPT). A warning, and only while VDP is active.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PersonaSettings } from '../../contract/persona';
import { DEFAULT_VDP_REFRESH_SCRIPT } from '../../contract/settings';
import { featureActive, personaOf } from '../../personas';
import { readVdpInfo } from '../mcp';
import { appDb } from './database';
import { bad, ok, tilde, type Check, type DoctorContext } from './types';

/**
 * D-55: whether the app's user has VDP active (Settings ▸ Role & rules), from the database the worker reads: the user
 * CC_USER_EMAIL names, else the first active user (the worker's rule). null when the database can't be read.
 */
export async function vdpActive(c: DoctorContext): Promise<boolean | null> {
  const email = c.env.CC_USER_EMAIL?.toLowerCase() || null;
  const rows = await c
    .withDb(appDb(c), (q) =>
      q(
        `select s.key, s.value from user_settings s
          where s.key in ('settings.persona', 'settings.profile')
            and s.owner_user_id = (select id from users where is_active and ($1::text is null or lower(email) = $1) order by created_at limit 1)`,
        [email],
      ),
    )
    .catch(() => null);
  if (!rows) return null;
  const by = new Map(rows.map((r) => [String(r.key), r.value]));
  const parsed = PersonaSettings.safeParse(by.get('settings.persona') ?? { version: 1 });
  return featureActive(personaOf({ persona: parsed.success ? parsed.data : null, profile: (by.get('settings.profile') ?? null) as { role?: string } | null }), 'vdp');
}

/** The cookie refresh script Health runs (Settings ▸ Sources), from the app database; the default when unset. */
export async function vdpRefreshScriptPath(c: DoctorContext): Promise<string> {
  const email = c.env.CC_USER_EMAIL?.toLowerCase() || null;
  const rows = await c
    .withDb(appDb(c), (q) =>
      q(
        `select s.value->>'vdpRefreshScript' as script from user_settings s
          where s.key = 'settings.scanning'
            and s.owner_user_id = (select id from users where is_active and ($1::text is null or lower(email) = $1) order by created_at limit 1)`,
        [email],
      ),
    )
    .catch(() => null);
  const script = typeof rows?.[0]?.script === 'string' && rows[0].script.trim() ? rows[0].script.trim() : DEFAULT_VDP_REFRESH_SCRIPT;
  return script.replace(/^~(?=\/)/, c.env.HOME ?? homedir());
}

/**
 * VDP is one persona feature (the SE's): a problem with it is a warning, and only while it is active. The Okta gateway
 * cookie lives one hour, so the refresh script has to be there too (lane E, E3: README ▸ VDP sign-in says where it
 * comes from).
 */
export const checkVdp: Check = async (c) => {
  if ((await vdpActive(c)) === false) return bad('skip', 'vdp', 'VDP access', "VDP is not in your role's preconfiguration (activate it in Settings ▸ Role & rules)");
  const v = readVdpInfo({ claudeJson: join(c.env.HOME ?? '', '.claude.json'), now: c.now });
  if (!v.configured) return bad('warn', 'vdp', 'VDP access', 'vdp-app-fir MCP entry missing', 'ask an admin for a VDP PAT, then add the vdp-app-fir MCP server (README ▸ VDP sign-in)', undefined, { code: 'AUTH.VDP.NOT_CONFIGURED', state: 'missing' });
  if (!v.hasPat) return bad('warn', 'vdp', 'VDP access', 'PAT missing', 'ask an admin for a VDP PAT (README ▸ VDP sign-in)', undefined, { code: 'AUTH.VDP.NO_PAT', state: 'missing' });
  const script = await vdpRefreshScriptPath(c);
  const hasScript = existsSync(script);
  const shown = tilde(script, c.env.HOME);
  const refresh = hasScript ? `python3 ${shown}` : `get the refresh script (README ▸ VDP sign-in), save it as ${shown}, then python3 ${shown}`;
  const data = { pat: 'present', cookie_seconds_left: v.cookieSecondsLeft, refresh_script: hasScript ? 'present' : 'missing' };
  if (!v.hasCookie || v.cookieSecondsLeft === null) return bad('warn', 'vdp', 'VDP access', 'PAT present, gateway cookie missing', refresh, data, { code: 'AUTH.VDP.COOKIE_EXPIRED', state: 'signed_out' });
  const mins = Math.round(v.cookieSecondsLeft / 60);
  if (v.cookieSecondsLeft <= 0) return bad('warn', 'vdp', 'VDP access', `PAT present, cookie expired ${Math.abs(mins)} min ago`, hasScript ? `${refresh}  (or the Health "Re-auth VDP" button)` : refresh, data, { code: 'AUTH.VDP.COOKIE_EXPIRED', state: 'expired' });
  if (!hasScript) return bad('warn', 'vdp', 'VDP access', `PAT present, cookie valid for ${mins} min, but no refresh script at ${shown} (the cookie lasts 1 h)`, refresh, data, { code: 'DEP.VDP.NO_SCRIPT', state: 'ok' });
  return ok('vdp', 'VDP access', `PAT present, cookie valid for ${mins} min`, data);
};
