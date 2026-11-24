/**
 * The VDP read client (vdp-app-fir over direct JSON-RPC, research 02 §7). Read tools only: `call()` refuses any tool
 * outside `VDP_READ_TOOLS`, and deletes and generation never pass (`./tools.ts`). Writes live in `./write.ts`, which
 * only the Outbox imports.
 *
 * VDP allows 60 MCP calls a minute per user; the client keeps under `maxPerMinute` (default 50) with a sliding
 * window, so a full mirror of many use cases spreads out instead of tripping the limit.
 */
import type { ConnectorHealthProbe } from '@/scanner/types';

import { httpJsonRpcRuntime } from '../runtime/http-jsonrpc';
import type { ConnectorRuntime } from '../runtime/types';

import { sleep } from '../util';
import { callVdpTool, listVdpTools, vdpCookieIssuedAtMs, vdpCookieSecondsLeft, type VdpHttpOptions, type VdpToolResult } from './http';
import { parseAssetTypes, parseCompanyLookup, parseCompanyVdps, parseDeliverableTypes, parseGetUseCase, parseGetVdp, parseIndustries, parseSalesSegments, parseSearchResult, parseToolList } from './parse';
import type { VdpCompanyLookup, VdpListRow, VdpServerTool, VdpSnapshot, VdpUseCase } from './types';
import type { VdpLimiter } from './limiter';
import { assertVdpTool, VDP_READ_TOOLS, type VdpReadTool } from './tools';

export { VdpAuthError, VdpError, vdpCookieSecondsLeft, type VdpErrorCode, type VdpToolResult } from './http';

export interface VdpClientOptions extends VdpHttpOptions {
  maxPerMinute?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** D-69 (VD-27): a limiter shared with the Outbox's VDP transport (the worker passes `vdpCallLimiter`). */
  limiter?: VdpLimiter;
  /** The read transport (an `http_jsonrpc` ConnectorRuntime). Default: `vdpReadRuntime` over these HTTP options. */
  runtime?: ConnectorRuntime;
}

/** VDP's read runtime: `tools/call` over JSON-RPC (src/connectors/vdp/http.ts), the read allowlist only. */
export function vdpReadRuntime(o: VdpHttpOptions = {}): ConnectorRuntime {
  return httpJsonRpcRuntime({ connector: 'vdp', readTools: VDP_READ_TOOLS, rpc: (tool, args, c) => callVdpTool(tool, args, 'read', { ...o, ...(c.signal ? { signal: c.signal } : {}) }) });
}

/** Refresh when 10 minutes or less remain (same threshold as the refresh script and Health). */
export const VDP_COOKIE_MIN_S = 10 * 60;
export const VDP_REFRESH_COMMAND = 'python3 ~/.claude/scripts/refresh_vdp_fir_cookie.py';

export class VdpClient {
  private readonly calls: number[] = [];
  private readonly max: number;
  private readonly rt: ConnectorRuntime;

  constructor(private readonly o: VdpClientOptions = {}) {
    this.max = Math.max(1, o.maxPerMinute ?? 50);
    this.rt = o.runtime ?? vdpReadRuntime(o);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Sliding-window limiter: at most `max` calls in any 60 s (the shared one, D-69, when given). */
  private async slot(signal?: AbortSignal): Promise<void> {
    if (this.o.limiter) return this.o.limiter.slot({ ...(signal ? { signal } : {}), now: () => this.now(), ...(this.o.sleep ? { sleep: this.o.sleep } : {}) });
    for (;;) {
      const t = this.now();
      while (this.calls.length && t - this.calls[0]! >= 60_000) this.calls.shift();
      if (this.calls.length < this.max) {
        this.calls.push(t);
        return;
      }
      await (this.o.sleep ?? sleep)(60_000 - (t - this.calls[0]!) + 50, signal);
    }
  }

  /** One read tool call. */
  async call(tool: VdpReadTool, args: Record<string, unknown> = {}, opts: { signal?: AbortSignal } = {}): Promise<VdpToolResult> {
    assertVdpTool(tool, 'read');
    await this.slot(opts.signal);
    const r = await this.rt.call(tool, args, opts.signal ? { signal: opts.signal } : {});
    return { text: r.text, json: r.json };
  }

  /** Every VDP the PAT's user can see (VDP scopes a per-user PAT to VDPs they are related to), paged 50 at a time. */
  async listMine(opts: { signal?: AbortSignal; maxPages?: number; includeArchived?: boolean } = {}): Promise<{ rows: VdpListRow[]; complete: boolean; total: number }> {
    const rows: VdpListRow[] = [];
    const maxPages = opts.maxPages ?? 10;
    let total = 0;
    for (let page = 0; page < maxPages; page++) {
      const r = parseSearchResult((await this.call('search_vdps', { limit: 50, offset: page * 50, include_archived: opts.includeArchived ?? false }, opts)).json);
      total = r.total;
      rows.push(...r.rows);
      if (!r.rows.length || rows.length >= total) return { rows, complete: true, total };
    }
    return { rows, complete: rows.length >= total, total };
  }

  async getVdp(slug: string, list?: Parameters<typeof parseGetVdp>[1], opts: { signal?: AbortSignal } = {}): Promise<VdpSnapshot | null> {
    return parseGetVdp((await this.call('get_vdp', { slug }, opts)).json, list);
  }

  async getUseCase(id: string, opts: { signal?: AbortSignal } = {}): Promise<VdpUseCase | null> {
    return parseGetUseCase((await this.call('get_use_case', { id }, opts)).json);
  }

  /** The server's tools and their argument names (`tools/list`, feature detection: D-59). One request. */
  async listTools(opts: { signal?: AbortSignal } = {}): Promise<VdpServerTool[]> {
    await this.slot(opts.signal);
    return parseToolList(await listVdpTools({ ...this.o, signal: opts.signal }));
  }

  /**
   * Does VDP know this company? `list_companies {q}` (a substring of the name, slug or an alias). D-69: up to 10 rows,
   * so a parent's company shows up next to its near namesakes.
   */
  async findCompany(name: string, opts: { signal?: AbortSignal } = {}): Promise<VdpCompanyLookup> {
    return parseCompanyLookup(name, (await this.call('list_companies', { q: name.slice(0, 200), limit: 10 }, opts)).json, new Date(this.now()).toISOString());
  }

  /** D-69 (VD-25): my VDPs of one company (`search_vdps company_id`), for the live check before a create_vdp. */
  async vdpsOfCompany(companyId: string, opts: { signal?: AbortSignal } = {}): Promise<Array<{ id: string; slug: string; fiscalYear: number | null; fiscalQuarter: number | null }>> {
    const r = parseSearchResult((await this.call('search_vdps', { company_id: companyId, limit: 50, offset: 0, include_archived: false }, opts)).json);
    return r.rows.filter((x) => !x.archived).map((x) => ({ id: x.id, slug: x.slug, fiscalYear: x.fiscalYear, fiscalQuarter: x.fiscalQuarter }));
  }

  /** D-69 (VD-07): `get_company {slug}`: how many VDPs VDP holds for the company (also the ones I am not on). */
  async companyVdps(slug: string, opts: { signal?: AbortSignal } = {}): Promise<{ id: string | null; vdpCount: number; vdpSlugs: string[] } | null> {
    return parseCompanyVdps((await this.call('get_company', { slug: slug.slice(0, 200) }, opts)).json);
  }

  /**
   * VDP's asset lookups in one read (`list_asset_types`, only once the server lists it): the asset types an asset's Type
   * picks from and the Deliverable types, each null when the result carries none.
   */
  async assetLookups(opts: { signal?: AbortSignal } = {}): Promise<{ assetTypes: string[] | null; deliverableTypes: string[] | null }> {
    const { json } = await this.call('list_asset_types', {}, opts);
    return { assetTypes: parseAssetTypes(json), deliverableTypes: parseDeliverableTypes(json) };
  }

  /** VDP's industry taxonomy, flat (`list_industries`, only once the server lists it: D-60), else null. */
  async industries(opts: { signal?: AbortSignal } = {}): Promise<ReturnType<typeof parseIndustries>> {
    return parseIndustries((await this.call('list_industries', {}, opts)).json);
  }

  /** VDP's sales segments (`list_sales_segments`, only once the server lists it: D-63), else null. */
  async salesSegments(opts: { signal?: AbortSignal } = {}): Promise<ReturnType<typeof parseSalesSegments>> {
    return parseSalesSegments((await this.call('list_sales_segments', {}, opts)).json);
  }

  /** E3: when the stored gateway cookie was issued (ms; config only, no network), or null. */
  cookieIssuedAt(): number | null {
    return vdpCookieIssuedAtMs(this.o);
  }

  /** Health from the config alone (no network): configured, PAT present, cookie lifetime. Never returns a value. */
  health(): ConnectorHealthProbe {
    const checkedAt = new Date(this.now()).toISOString();
    const v = vdpCookieSecondsLeft(this.o);
    const reauth = { kind: 'refresh_script' as const, command: VDP_REFRESH_COMMAND, instructions: `Run in Terminal: ${VDP_REFRESH_COMMAND}. A browser window opens for Okta MFA when the session lapsed.` };
    if (!v.configured) return { state: 'disabled', errorClass: 'config', detail: 'not_configured: vdp-app-fir is not in the Claude config (an admin issues the PAT)', checkedAt };
    if (!v.hasPat) return { state: 'auth_required', errorClass: 'auth', detail: 'pat_missing: ask an admin for a VDP PAT', checkedAt };
    if (v.secondsLeft === null) return { state: 'auth_required', errorClass: 'auth', detail: 'cookie_missing: the Okta gateway cookie is missing', reauth, checkedAt };
    if (v.secondsLeft <= 0) return { state: 'auth_required', errorClass: 'auth', detail: `cookie_expired: expired ${Math.round(-v.secondsLeft / 60)} min ago`, reauth, checkedAt };
    if (v.secondsLeft < VDP_COOKIE_MIN_S) return { state: 'degraded', errorClass: 'auth', detail: `cookie_expiring: ${Math.round(v.secondsLeft / 60)} min left`, reauth, checkedAt };
    return { state: 'ok', detail: `cookie valid for ${Math.round(v.secondsLeft / 60)} min`, checkedAt };
  }
}
