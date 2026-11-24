/**
 * devbar and the Google bridge (CONN-5): installed (DEP.DEVBAR.MISSING), recent enough (DEP.DEVBAR.TOO_OLD), signed
 * in (AUTH.GOOGLE.DEVBAR_SIGNED_OUT), its gateway listening (DEP.DEVBAR.DAEMON_DOWN), and the Google connector
 * answering (AUTH.GOOGLE.CONNECTOR_MISSING). Status JSON only; the account's email is never echoed.
 */
import { MIN_DEVBAR } from '../../errors/catalog';
import { bad, ok, parseVersion, versionBelow, type Check } from './types';

const LABEL = 'devbar + Google bridge';

export const checkDevbar: Check = async (c) => {
  const auth = await c.exec('devbar', ['auth', 'status', '--json'], { timeoutMs: 10_000 });
  if (auth.spawnError) return bad('fail', 'devbar', LABEL, 'devbar not installed', 'install devbar (internal developer portal; README ▸ Troubleshooting: Google (devbar)), then devbar auth login', undefined, { code: 'DEP.DEVBAR.MISSING', state: 'missing' });
  let authed = false;
  try {
    authed = (JSON.parse(auth.stdout) as { authenticated?: boolean }).authenticated === true;
  } catch {
    /* treated as signed out */
  }
  const v = await c.exec('devbar', ['--version'], { timeoutMs: 5000 });
  const version = v.code === 0 && parseVersion(v.stdout) ? (/\d+\.\d+(?:\.\d+)?/.exec(v.stdout)?.[0] ?? null) : null;
  const vdata = version ? { version, min: MIN_DEVBAR } : undefined;
  if (version && versionBelow(version, MIN_DEVBAR)) return bad('warn', 'devbar', LABEL, `devbar ${version} is older than ${MIN_DEVBAR}`, 'devbar update', vdata, { code: 'DEP.DEVBAR.TOO_OLD', state: 'installed' });
  if (!authed) return bad('fail', 'devbar', LABEL, 'signed out', 'devbar auth login', vdata, { code: 'AUTH.GOOGLE.DEVBAR_SIGNED_OUT', state: 'signed_out' });
  const gw = await c.exec('devbar', ['mcpgw', 'status', '--json'], { timeoutMs: 10_000 });
  let status: { listener_ok?: boolean; upstream_ok?: boolean; port?: number } = {};
  try {
    status = JSON.parse(gw.stdout);
  } catch {
    /* handled below */
  }
  if (!status.listener_ok) return bad('fail', 'devbar', LABEL, 'gateway listener is down', 'devbar daemon start', vdata, { code: 'DEP.DEVBAR.DAEMON_DOWN', state: 'installed' });
  const port = status.port ?? 13316;
  const http = await c.fetchStatus(`http://localhost:${port}/proxy/mcp/server/google_workspace_readonly/mcp`);
  if (http === null || http >= 500) {
    return bad('warn', 'devbar', LABEL, `google_workspace_readonly not answering on :${port}`, 'devbar mcpgw connectors connect google-workspace-readonly', vdata, { code: 'AUTH.GOOGLE.CONNECTOR_MISSING', state: 'signed_out' });
  }
  if (status.upstream_ok === false) return bad('warn', 'devbar', LABEL, 'bridge up, upstream not ok', 'devbar mcpgw connectors connect google-workspace-readonly', vdata, { code: 'AUTH.GOOGLE.CONNECTOR_MISSING', state: 'signed_out' });
  return ok('devbar', LABEL, `signed in; google_workspace_readonly reachable on :${port}`, vdata);
};
