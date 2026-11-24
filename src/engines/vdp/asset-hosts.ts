/**
 * VDP autopilot's trusted asset sites (pure; D-60 amended 2026-11-21, SEC-6). Asset candidates come from a search over
 * untrusted text (Slack, Gmail, Drive), so autopilot adds a link by itself only when it is on a site the user trusts
 * (Settings ▸ Sending, `autopilotAssetHosts`); any other link waits for the user's Apply, never dropped.
 *
 * A link is trusted when, all of:
 *   - it is https (not http, not anything else);
 *   - it carries no user name or password (`https://docs.google.com@evil.example/…` is on evil.example, and refused);
 *   - it names no port (`:8443`); the default 443 is fine (the URL parser drops it);
 *   - its host is a name, not an IP address (v4, v6 or the parser's numeric forms);
 *   - its host is an entry, or a subdomain of one (`evilsalesforce.com` is not under `salesforce.com`). An IDN host is
 *     compared as punycode, so a look-alike (`drive.gооgle.com` with Cyrillic о) never matches `drive.google.com`.
 */
import { AutopilotAssetHost } from '@/contract';

export type AssetHostVerdict = { trusted: true; host: string } | { trusted: false; host: string | null; why: string };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const isIp = (host: string) => IPV4.test(host) || host.startsWith('[') || host.includes(':');

/**
 * One trusted-site entry as stored: what the user typed ("https://Docs.Google.com/x", "*.force.com", "bücher.example")
 * → its lower-case host name, IDN as punycode; null when it is not a site name (an IP, a port, a user name, junk).
 */
export function normaliseAssetHost(input: string): string | null {
  const raw = input.trim().replace(/^\*\./, '').replace(/^\./, '');
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.replace(/\.$/, '');
  if (!host || isIp(host)) return null;
  const r = AutopilotAssetHost.safeParse(host);
  return r.success ? r.data : null;
}

/** Whether autopilot may add this link by itself, and, when not, the host and why (shown on the held item). */
export function trustedAssetHost(url: string, hosts: readonly string[]): AssetHostVerdict {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return { trusted: false, host: null, why: 'Held for you: not a valid link' };
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (u.protocol !== 'https:') return { trusted: false, host, why: 'Held for you: the link is not https' };
  if (u.username || u.password) return { trusted: false, host, why: `Held for you: the link carries a user name (it goes to ${host}), not a trusted site` };
  if (u.port) return { trusted: false, host, why: `Held for you: the link uses port ${u.port} on ${host}` };
  if (!host || isIp(host)) return { trusted: false, host, why: 'Held for you: link is on an IP address, not a trusted site' };
  const entries = hosts.map(normaliseAssetHost).filter((h): h is string => !!h);
  if (entries.some((e) => host === e || host.endsWith(`.${e}`))) return { trusted: true, host };
  return { trusted: false, host, why: `Held for you: link is on ${host}, not a trusted site` };
}
