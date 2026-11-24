/**
 * Outbox transports.
 *
 * - `liveOutboxTransport()` is FAIL-CLOSED for Slack and Gmail in this build: every call rejects before anything
 *   is opened. Their live write path (Slack's OAuth MCP via a headless Claude run, devbar's mcp-adaptor over
 *   stdio) needs a live check that the user approves first; until then a non-dry-run delivery on the real path
 *   ends in an Outbox error ("Live delivery is not enabled in this build"), and nothing leaves the machine.
 *   VDP (approved 2026-11-10) is live: a `vdp-app-fir` call goes to the VDP write transport
 *   (src/connectors/vdp/write.ts). It is reached only after the user's Apply on that one item, with global
 *   dry-run off, through the gateway's allowlist and single-use confirm proof.
 *   The feedback report (approved 2026-11-11, D-56) is the ONE live `slack_send_message`: the feedback relay carries it
 *   only for the `feedback` channel (the gateway says which adapter made the call), only to the configured channel id
 *   (re-resolved at the call: Settings ▸ Feedback, else config/team.json, and only while "Post live" is on), only top-level
 *   with exactly {channel_id, message}, and only with a confirm proof the gateway spent on exactly this call. Without the
 *   `feedback` option (every caller but the worker) it is absent, so the post fails closed like any other Slack send.
 *   A release announcement (D-90, W12-7) rides the same relay as its own `release` channel: only to the configured
 *   announcement channel (the `distribution` settings key, else config/team.json), only top-level, only with a spent confirm. A
 *   `release.drive_upload` hand-off never reaches a transport (its adapter refuses every call).
 * - `SimulatedOutboxTransport` is an in-memory stand-in for the mock DataSource (CC_DATA=mock never calls any
 *   external system, even with dry-run off). It accepts the four write tools, remembers what it "posted",
 *   and answers the read-back tools from that memory, so the mock exercises the real adapters end to end.
 */
import type { McpServerConfig } from '@/llm/provider';

import { vdpCallLimiter } from '@/connectors/vdp/limiter';
import { vdpWriteTransport } from '@/connectors/vdp/write';
import { FEEDBACK_CHANNEL_ID } from '@/lib/feedback/payload';
import { RELEASE_CHANNEL_ID } from './adapters/release-handoff';
import { SLACK_ALL_TOOLS } from '@/llm/mcp-config';
import { runOneToolCall, type OneCallInput } from '@/llm/one-call';
import { loadSkill } from '@/llm/skill-loader';

import { CANVAS_RELAY_TOOLS, RELAY_SKILL, slackCanvasRelay } from './relay';

import { assertSpentOn } from './confirm';
import { relayFailure, ToolCallError } from './errors';
import type { OutboxTransport, TransportCallOptions } from './gateway';
import { OUTBOX_SERVER, OUTBOX_TOOLS, OutboxToolRefusedError, outboxToolName, resolveOutboxServer } from './mcp-config';
import type { ToolCall, ToolResult } from './types';

export class OutboxLiveDisabledError extends Error {
  override name = 'OutboxLiveDisabledError';
  constructor() {
    super('live outbox transport is not enabled in this build (a live check needs the user to approve it first)');
  }
}

export interface LiveOutboxOptions {
  /** The VDP write transport (default: the real one). `null`: VDP fails closed like the other channels. */
  vdp?: OutboxTransport | null;
  /** The logging-canvas relay (default: the real one, src/outbox/relay.ts). `null`: canvases fail closed. */
  canvas?: OutboxTransport | null;
  /** The feedback post (D-56). Absent (the default) or `null`: a feedback post fails closed. The worker wires it. */
  feedback?: FeedbackRelayOptions | null;
  /** The release announcement (D-90). Absent (the default) or `null`: an announcement fails closed. The worker wires it. */
  release?: FeedbackRelayOptions | null;
}

/** A live relay for structured actions: one server, and only the tools it names (and, optionally, only for one channel). */
interface Relay {
  server: string;
  tools: ReadonlySet<string>;
  transport: OutboxTransport;
  /** Extra match on the call's options (the feedback relay: a send only for the feedback channel's adapter). */
  match?: (call: ToolCall, opts: TransportCallOptions | undefined) => boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// The feedback relay (D-56)
// ---------------------------------------------------------------------------

export interface FeedbackRelayOptions {
  /**
   * The configured feedback channel id while posting is allowed (Settings ▸ Feedback, else config/team.json, and "Post
   * live" on), else null. Re-read on every call, so switching it off wins right up to the post.
   */
  channel: () => Promise<string | null> | string | null;
  /** The post itself (default: one relayed Slack call through Claude's Slack MCP, like the canvas). Tests: a fake. */
  transport?: OutboxTransport;
  /** Tests of the default transport: a fake one-call runner and server declaration. */
  run?: (c: OneCallInput) => ReturnType<typeof runOneToolCall>;
  server?: () => Record<string, unknown>;
}

const FEEDBACK_SEND = OUTBOX_TOOLS.feedback.write.send;
const FEEDBACK_READS: ReadonlySet<string> = new Set(OUTBOX_TOOLS.feedback.read);
export const FEEDBACK_RELAY_TOOLS: ReadonlySet<string> = new Set([FEEDBACK_SEND, ...FEEDBACK_READS]);

/** The one-message channels a relay carries: a feedback report (D-56) or a release announcement (D-90). */
type PostChannel = 'feedback' | 'release';
const POST: Record<PostChannel, { id: RegExp; what: string; unset: string }> = {
  feedback: { id: FEEDBACK_CHANNEL_ID, what: 'a feedback report', unset: 'no feedback channel is configured, or posting feedback is off' },
  release: { id: RELEASE_CHANNEL_ID, what: 'a release announcement', unset: 'no announcement channel is configured' },
};

const refuse = (call: ToolCall, why: string, ch: PostChannel = 'feedback') => new OutboxToolRefusedError(outboxToolName(call.server, call.tool), `${ch} relay: ${why}`);

/** One relayed Slack call (only the Slack server loads, only this one tool may run). */
function slackOneCall(o: Pick<FeedbackRelayOptions, 'run' | 'server'>): OutboxTransport {
  return {
    async callTool(call: ToolCall): Promise<ToolResult> {
      const server = OUTBOX_SERVER.feedback;
      const full = outboxToolName(server, call.tool);
      let servers: Record<string, unknown>;
      try {
        servers = o.server ? o.server() : { [server]: resolveOutboxServer('feedback') as unknown as McpServerConfig };
      } catch {
        throw new ToolCallError(call.tool, 'Slack is not set up in Claude Code (no slack MCP server in ~/.claude.json)');
      }
      const r = await (o.run ?? runOneToolCall)({
        servers,
        fullTool: full,
        args: call.args,
        allowedTools: [full],
        disallowedTools: SLACK_ALL_TOOLS.filter((t) => t !== call.tool).map((t) => outboxToolName(server, t)),
        skill: loadSkill(RELAY_SKILL),
        timeoutMs: 90_000,
      });
      if (r.text === null) throw relayFailure(call.tool, r);
      return { text: r.text };
    },
  };
}

/**
 * The feedback relay: `slack_send_message` for a feedback report and `slack_read_thread` for its read-back, nothing
 * else, and only in the configured channel. Every refusal throws before the inner transport is touched. With `ch:
 * 'release'` it is the release relay: the same rules for an announcement in the configured announcement channel.
 */
export const releaseRelay = (o: FeedbackRelayOptions): OutboxTransport => feedbackRelay(o, 'release');

export function feedbackRelay(o: FeedbackRelayOptions, ch: PostChannel = 'feedback'): OutboxTransport {
  const inner = o.transport ?? slackOneCall(o);
  const p = POST[ch];
  return {
    async callTool(call, opts): Promise<ToolResult> {
      if (call.server !== OUTBOX_SERVER[ch] || !FEEDBACK_RELAY_TOOLS.has(call.tool)) throw refuse(call, `carries ${[...FEEDBACK_RELAY_TOOLS].join(' and ')} only`, ch);
      const allowed = await o.channel();
      if (!allowed || !p.id.test(allowed)) throw refuse(call, p.unset, ch);
      if (String(call.args.channel_id ?? '') !== allowed) throw refuse(call, `only the configured ${ch === 'feedback' ? 'feedback' : 'announcement'} channel`, ch);
      if (call.tool === FEEDBACK_SEND) {
        if (opts?.channel !== ch) throw refuse(call, `slack_send_message is carried for ${p.what} only`, ch);
        const keys = Object.keys(call.args).sort().join(',');
        if (keys !== 'channel_id,message' || typeof call.args.message !== 'string' || !call.args.message.trim()) throw refuse(call, `${ch === 'feedback' ? 'a report' : 'an announcement'} is one top-level message: {channel_id, message} only`, ch);
        // The proof the gateway spent on exactly this call (NotConfirmedError otherwise).
        assertSpentOn(opts.proof, call);
      }
      return inner.callTool(call, opts);
    },
  };
}

/**
 * The live transport: one transport that routes each call to the relay for its server AND tool. Anything without
 * a relay (Slack and Gmail message sends today) fails closed before anything is opened.
 */
export function liveOutboxTransport(o: LiveOutboxOptions = {}): OutboxTransport {
  const relays: Relay[] = [];
  // D-69 (VD-27): the worker's VDP writes share one window with its VDP reads (60 calls a minute upstream)
  const vdp = o.vdp === undefined ? vdpWriteTransport({ limiter: vdpCallLimiter }) : o.vdp;
  if (vdp) relays.push({ server: OUTBOX_SERVER.vdp, tools: new Set([...(OUTBOX_TOOLS.vdp.ops ?? []), ...OUTBOX_TOOLS.vdp.read]), transport: vdp });
  // The logging canvas (D-47): keyed by tool too, so this relay on the `slack` server never carries slack_send_message.
  const canvas = o.canvas === undefined ? slackCanvasRelay() : o.canvas;
  if (canvas) relays.push({ server: OUTBOX_SERVER.slack_canvas, tools: CANVAS_RELAY_TOOLS, transport: canvas });
  // The feedback post (D-56): a send only when the feedback adapter made it; any other Slack send stays fail-closed.
  // The release announcement (D-90): first, so its read-back (in its own channel) is not taken by the feedback relay.
  const rel = o.release;
  if (rel) relays.push({ server: OUTBOX_SERVER.release, tools: FEEDBACK_RELAY_TOOLS, transport: releaseRelay(rel), match: async (call, opts) => (call.tool === FEEDBACK_SEND ? opts?.channel === 'release' : String(call.args.channel_id ?? '') === ((await rel.channel()) ?? '\0')) });
  if (o.feedback) relays.push({ server: OUTBOX_SERVER.feedback, tools: FEEDBACK_RELAY_TOOLS, transport: feedbackRelay(o.feedback), match: (call, opts) => call.tool !== FEEDBACK_SEND || opts?.channel === 'feedback' });
  return {
    async callTool(call, opts): Promise<ToolResult> {
      for (const r of relays) if (r.server === call.server && r.tools.has(call.tool) && (!r.match || (await r.match(call, opts)))) return r.transport.callTool(call, opts);
      throw new OutboxLiveDisabledError();
    },
  };
}

interface Stored {
  kind: 'slack_message' | 'slack_draft' | 'gmail_message' | 'gmail_draft' | 'vdp_use_case' | 'vdp_header' | 'vdp_company' | 'vdp_asset' | 'slack_canvas';
  id: string;
  channel?: string;
  threadTs?: string;
  subject?: string;
  body: string;
  /** VDP rows: the fields the simulated writes set. */
  fields?: Record<string, unknown>;
}

const VDP_WRITES = ['update_use_case', 'create_use_case', 'update_vdp_header', 'create_vdp', 'create_company', 'add_vdp_asset', 'set_vdp_owners', 'generate_use_case'];

/** In-memory fake destination. Never opens a socket, file or process. */
export class SimulatedOutboxTransport implements OutboxTransport {
  readonly calls: ToolCall[] = [];
  private readonly items: Stored[] = [];
  private seq = 0;
  /** Test/dev hook: make the next write fail with this tool error text (e.g. "channel_not_found"). */
  failNextWith: string | null = null;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  private nextTs(): string {
    const secs = Math.floor(this.clock().getTime() / 1000);
    return `${secs}.${String(100000 + this.seq++).slice(-6)}`;
  }

  async callTool(call: ToolCall): Promise<ToolResult> {
    this.calls.push(structuredClone(call));
    const a = call.args;
    const isWrite = ['slack_send_message', 'slack_send_message_draft', 'send_gmail_message', 'draft_gmail_message', 'slack_create_canvas', ...VDP_WRITES].includes(call.tool);
    if (isWrite && this.failNextWith) {
      const text = this.failNextWith;
      this.failNextWith = null;
      return { isError: true, text };
    }
    switch (call.tool) {
      case 'slack_send_message': {
        const ts = this.nextTs();
        this.items.push({ kind: 'slack_message', id: ts, channel: String(a.channel_id), threadTs: a.thread_ts ? String(a.thread_ts) : undefined, body: String(a.message) });
        return { text: JSON.stringify({ ok: true, channel: a.channel_id, ts, permalink: `https://simulated.slack.com/archives/${String(a.channel_id)}/p${ts.replace('.', '')}` }) };
      }
      case 'slack_send_message_draft': {
        const id = `Dr${String(++this.seq).padStart(8, '0')}`;
        this.items.push({ kind: 'slack_draft', id, channel: String(a.channel_id), body: String(a.message) });
        return { text: JSON.stringify({ ok: true, draft_id: id, channel_link: `https://app.slack.com/client/TSIM/${String(a.channel_id)}` }) };
      }
      case 'slack_read_thread': {
        const ts = String(a.oldest ?? a.message_ts);
        const m = this.items.find((x) => x.kind === 'slack_message' && x.channel === String(a.channel_id) && (x.id === ts || x.threadTs === String(a.message_ts)));
        if (!m) return { isError: true, text: 'thread_not_found' };
        return { text: `Message_ts: ${m.id}\nText: ${m.body}` };
      }
      case 'send_gmail_message': {
        const id = `sim${String(++this.seq).padStart(12, '0')}`;
        this.items.push({ kind: 'gmail_message', id, subject: String(a.subject), body: String(a.body) });
        return { text: `Email sent! Message ID: ${id}` };
      }
      case 'draft_gmail_message': {
        const id = `sim${String(++this.seq).padStart(12, '0')}`;
        this.items.push({ kind: 'gmail_draft', id, subject: String(a.subject), body: String(a.body) });
        return { text: `Draft created! Draft ID: r-${id} Message ID: ${id}` };
      }
      case 'get_gmail_message_content': {
        const m = this.items.find((x) => (x.kind === 'gmail_message' || x.kind === 'gmail_draft') && x.id === String(a.message_id));
        if (!m) return { isError: true, text: 'Requested entity was not found. (404)' };
        return { text: `Subject: ${m.subject}\n\n${m.body}` };
      }
      case 'search_gmail_messages': {
        const subject = /subject:"([^"]*)"/.exec(String(a.query))?.[1]?.trim().toLowerCase();
        const hits = this.items.filter((x) => x.kind === 'gmail_draft' && (!subject || (x.subject ?? '').toLowerCase().includes(subject)));
        return { text: hits.length ? hits.map((h) => `Message ID: ${h.id}`).join('\n') : 'No messages found' };
      }
      case 'slack_create_canvas': {
        const id = `FSIM${String(++this.seq).padStart(8, '0')}`;
        this.items.push({ kind: 'slack_canvas', id, subject: String(a.title), body: String(a.content) });
        return { text: JSON.stringify({ ok: true, canvas_id: id, canvas_url: `https://simulated.slack.com/docs/TSIM/${id}` }) };
      }
      case 'slack_read_canvas': {
        const c = this.items.find((x) => x.kind === 'slack_canvas' && x.id === String(a.canvas_id));
        if (!c) return { isError: true, text: 'canvas_not_found' };
        return { text: `# ${c.subject}\n\n${c.body}` };
      }
      case 'update_use_case':
      case 'create_use_case': {
        const id = call.tool === 'create_use_case' ? `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}` : String(a.id);
        const row = this.items.find((x) => x.kind === 'vdp_use_case' && x.id === id) ?? this.items[this.items.push({ kind: 'vdp_use_case', id, body: '', fields: { id } }) - 1]!;
        const { id: _id, vdp_id: vdpId, ...fields } = a;
        row.fields = { ...row.fields, ...fields, ...(vdpId ? { vdpId } : {}) };
        return { text: JSON.stringify({ use_case: row.fields, vdp_url: 'https://vdp.simulated.test/vdp/sim', message: 'Updated use case (simulated).' }) };
      }
      case 'update_vdp_header': {
        const id = String(a.vdp_id);
        const row = this.items.find((x) => x.kind === 'vdp_header' && x.id === id) ?? this.items[this.items.push({ kind: 'vdp_header', id, body: '', fields: { id } }) - 1]!;
        const { vdp_id: _v, add_opportunity_ids: add, remove_opportunity_ids: remove, entitlement_leveraged: ent, ...fields } = a;
        const gone = new Set((Array.isArray(remove) ? remove.map(String) : []).map((x) => x.slice(0, 15)));
        const ids = [...((row.fields?.salesforceOpportunityIds as string[] | undefined) ?? []), ...(Array.isArray(add) ? add.map(String) : [])].filter((x) => !gone.has(x.slice(0, 15)));
        // D-63: VDP returns the entitlement camelCase on the VDP it answers with
        row.fields = { ...row.fields, ...fields, ...(Array.isArray(add) || gone.size ? { salesforceOpportunityIds: [...new Set(ids)] } : {}), ...(ent !== undefined ? { entitlementLeveraged: ent } : {}) };
        return { text: JSON.stringify({ vdp: row.fields, message: 'Updated VDP header (simulated).' }) };
      }
      case 'create_vdp': {
        const id = `00000000-0000-4000-9000-${String(++this.seq).padStart(12, '0')}`;
        const slug = `sim-vdp-${this.seq}`;
        const { salesforce_opportunity_ids: opps, company_id: companyId, ...rest } = a;
        const fields = { id, slug, company: { id: companyId }, ...rest, salesforceOpportunityIds: Array.isArray(opps) ? opps.map(String) : [], vdp_url: `https://vdp.simulated.test/vdp/${slug}` };
        this.items.push({ kind: 'vdp_header', id, body: '', fields });
        return { text: JSON.stringify({ vdp: fields, message: `Created VDP ${slug} (simulated).` }) };
      }
      case 'set_vdp_owners': {
        const row = this.items.find((x) => x.kind === 'vdp_header' && x.id === String(a.vdp_id)) ?? this.items[this.items.push({ kind: 'vdp_header', id: String(a.vdp_id), body: '', fields: { id: String(a.vdp_id) } }) - 1]!;
        const people = (v: unknown) => (Array.isArray(v) ? v.map((email) => ({ email: String(email) })) : undefined);
        row.fields = { ...row.fields, ...(a.account_executives ? { accountExecutives: people(a.account_executives) } : {}), ...(a.technical_architects ? { technicalArchitects: people(a.technical_architects) } : {}) };
        return { text: JSON.stringify({ vdp: row.fields, message: 'Set the VDP owners (simulated).' }) };
      }
      case 'create_company': {
        const id = `00000000-0000-4000-a000-${String(++this.seq).padStart(12, '0')}`;
        const fields = { id, name: String(a.name), slug: String(a.name).toLowerCase().replace(/[^a-z0-9]+/g, '-') };
        this.items.push({ kind: 'vdp_company', id, body: '', fields });
        return { text: JSON.stringify({ company: fields, message: 'Created the company (simulated).' }) };
      }
      case 'list_companies': {
        const q = String(a.q ?? '').toLowerCase();
        return { text: JSON.stringify({ companies: this.items.filter((x) => x.kind === 'vdp_company' && String(x.fields?.name ?? '').toLowerCase().includes(q)).map((x) => x.fields) }) };
      }
      case 'add_vdp_asset': {
        const id = `00000000-0000-4000-b000-${String(++this.seq).padStart(12, '0')}`;
        const fields = { id, ...a };
        this.items.push({ kind: 'vdp_asset', id, body: '', fields });
        return { text: JSON.stringify({ asset: fields, message: 'Added the asset (simulated).' }) };
      }
      case 'get_vdp_assets':
        return { text: JSON.stringify({ assets: this.items.filter((x) => x.kind === 'vdp_asset' && x.fields?.vdp_id === a.vdp_id).map((x) => x.fields) }) };
      case 'generate_use_case': {
        const ucId = String(a.use_case_id);
        const row = this.items.find((x) => x.kind === 'vdp_use_case' && x.id === ucId) ?? this.items[this.items.push({ kind: 'vdp_use_case', id: ucId, body: '', fields: { id: ucId } }) - 1]!;
        row.fields = { ...row.fields, generated_fields: { executive_summary: 'Simulated summary.' } };
        return { text: JSON.stringify({ use_case: row.fields, message: 'Generated (simulated).' }) };
      }
      case 'get_use_case': {
        const row = this.items.find((x) => x.kind === 'vdp_use_case' && x.id === String(a.id));
        return { text: JSON.stringify({ use_case: row?.fields ?? null }) };
      }
      case 'get_vdp': {
        const rows = this.items.filter((x) => x.kind === 'vdp_header');
        const row = rows.find((x) => x.fields?.slug === a.slug) ?? rows.find((x) => !x.fields?.slug);
        return { text: JSON.stringify({ vdp: row?.fields ?? null }) };
      }
      default:
        return { isError: true, text: `unknown tool ${call.tool}` };
    }
  }
}
