/**
 * BE-OUTBOX · allowlist separation guard (CLAUDE.md invariant 2, *tenet: Read-only ingest*).
 *
 * - The scanner allowlists (src/llm/mcp-config.ts, the Google read client) contain no write tool, and no
 *   outbox write tool can ever pass the scanner's read-only check.
 * - The outbox has its own tiny allowlist: exactly one draft and one send tool per channel, plus reads.
 * - D-56 widens the LIVE transport by exactly one thing: `slack_send_message` for a feedback report (channel
 *   `feedback`), only to the configured channel, only with a confirm proof the gateway spent on that call. No new tool
 *   joins the allowlist; every other Slack send stays fail-closed.
 * - `src/outbox/mcp-config.ts` is importable only from `src/outbox/**` (and this lane's tests), and the
 *   scanner side never imports the outbox at all.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GOOGLE_READ_TOOLS, assertReadTool } from '../../src/connectors/google/client';
import { VDP_READ_TOOLS, VDP_WRITE_TOOLS } from '../../src/connectors/vdp/tools';
import { assertReadOnly, ORG62_SCAN_TOOLS, restrictedTools, SLACK_SCAN_TOOLS } from '../../src/llm/mcp-config';
import { OUTBOX_ALLOWLIST, OUTBOX_READ_TOOLS, OUTBOX_SERVER, OUTBOX_TOOLS, OUTBOX_WRITE_TOOLS, assertOutboxTool, outboxAllowedTools, resolveOutboxServer, writeToolsFor } from '../../src/outbox/mcp-config';
import { confirmDelivery, liveOutboxTransport, OutboxGateway, OutboxLiveDisabledError, payloadHash, type DeliveryConfirmation, type ToolCall } from '../../src/outbox';
import { feedbackActionFor } from '../../src/lib/feedback/payload';
import { actionPayloadFor } from '../../src/lib/actions';
import { FakeMcp } from './fake';

const ROOT = path.resolve(__dirname, '../..');
const bare = (q: string) => q.replace(/^mcp__[^_]+(?:[-_][^_]+)*?__/, '');

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const importsOf = (file: string) => [...fs.readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]!);

describe('scanner allowlists stay read-only', () => {
  const scannerLists = { slack: [...SLACK_SCAN_TOOLS], org62: [...ORG62_SCAN_TOOLS], google: [...GOOGLE_READ_TOOLS], vdp: [...VDP_READ_TOOLS] };

  it('contain none of the outbox write tools', () => {
    const writes = new Set([...OUTBOX_WRITE_TOOLS].map(bare));
    for (const [name, list] of Object.entries(scannerLists)) {
      for (const t of list) expect(writes.has(t), `${name} scanner allowlists ${t}`).toBe(false);
    }
    const slack = restrictedTools('slack');
    for (const t of slack.allowedTools) expect(OUTBOX_WRITE_TOOLS.has(t)).toBe(false);
    // …and the scanner config actively denies the Slack write tools
    expect(slack.disallowedTools).toEqual(expect.arrayContaining(['mcp__slack__slack_send_message', 'mcp__slack__slack_send_message_draft']));
  });

  // D-59: the write list widened by create_vdp and the four pending tools (used only once VDP's server lists them)
  it('the VDP read list holds no write, delete or generate tool, and its write list is only the Outbox ops', () => {
    expect(VDP_READ_TOOLS.some((t) => /^(create|update|delete|generate|add|set)_/.test(t))).toBe(false);
    expect([...VDP_WRITE_TOOLS].sort()).toEqual(['add_vdp_asset', 'create_company', 'create_use_case', 'create_vdp', 'generate_use_case', 'set_vdp_owners', 'update_use_case', 'update_vdp_header']);
    expect(Object.isFrozen(VDP_READ_TOOLS) && Object.isFrozen(VDP_WRITE_TOOLS)).toBe(true);
  });

  it('contain no write-like tool at all', () => {
    expect(() => assertReadOnly(restrictedTools('slack').allowedTools)).not.toThrow();
    expect(() => assertReadOnly(restrictedTools('org62').allowedTools)).not.toThrow();
    for (const t of GOOGLE_READ_TOOLS) expect(() => assertReadTool(t)).not.toThrow();
    for (const t of scannerLists.slack) expect(t).toMatch(/^slack_(search|read|list)_/);
  });

  it('can never be widened with an outbox write tool (the scanner guards refuse every one)', () => {
    for (const t of OUTBOX_WRITE_TOOLS) expect(() => assertReadOnly([t]), t).toThrow(/write-like/);
    expect(() => restrictedTools('slack', ['slack_send_message'])).toThrow(/write-like/);
    expect(() => restrictedTools('slack', ['slack_send_message_draft'])).toThrow(/write-like/);
    for (const t of ['draft_gmail_message', 'send_gmail_message']) expect(() => assertReadTool(t)).toThrow();
  });
});

describe('the outbox allowlist is its own, tiny and explicit', () => {
  it('has exactly one draft and one send tool per message channel, VDP\'s ops (D-46, D-59), and the logging canvas create', () => {
    expect([...OUTBOX_WRITE_TOOLS].sort()).toEqual([
      'mcp__mcp-adaptor__draft_gmail_message',
      'mcp__mcp-adaptor__send_gmail_message',
      'mcp__slack__slack_create_canvas',
      'mcp__slack__slack_send_message',
      'mcp__slack__slack_send_message_draft',
      'mcp__vdp-app-fir__add_vdp_asset',
      'mcp__vdp-app-fir__create_company',
      'mcp__vdp-app-fir__create_use_case',
      'mcp__vdp-app-fir__create_vdp',
      'mcp__vdp-app-fir__generate_use_case',
      'mcp__vdp-app-fir__set_vdp_owners',
      'mcp__vdp-app-fir__update_use_case',
      'mcp__vdp-app-fir__update_vdp_header',
    ]);
    expect([...OUTBOX_READ_TOOLS].sort()).toEqual([
      'mcp__mcp-adaptor__get_gmail_message_content',
      'mcp__mcp-adaptor__search_gmail_messages',
      'mcp__slack__slack_read_canvas',
      'mcp__slack__slack_read_thread',
      'mcp__vdp-app-fir__get_use_case',
      'mcp__vdp-app-fir__get_vdp',
      'mcp__vdp-app-fir__get_vdp_assets',
      'mcp__vdp-app-fir__list_companies',
    ]);
    expect(OUTBOX_ALLOWLIST.size).toBe(21);
    // D-56: the feedback channel adds NO tool; it is the message channel's own send, on its own channel key
    expect(OUTBOX_SERVER.feedback).toBe('slack');
    expect(outboxAllowedTools('feedback', 'send')).toEqual(['mcp__slack__slack_send_message', 'mcp__slack__slack_read_thread']);
    expect(outboxAllowedTools('feedback', 'draft')).toEqual(['mcp__slack__slack_send_message', 'mcp__slack__slack_read_thread']);
    expect(writeToolsFor('feedback', 'send').tools).toEqual(['slack_send_message']);
    expect(Object.isFrozen(OUTBOX_TOOLS.feedback) && Object.isFrozen(OUTBOX_TOOLS.feedback.write)).toBe(true);
    // the canvas channel creates a NEW private canvas only: never rewrites one, never posts a message (D-47)
    expect(outboxAllowedTools('slack_canvas', 'send')).toEqual(['mcp__slack__slack_create_canvas', 'mcp__slack__slack_read_canvas']);
    expect(OUTBOX_ALLOWLIST.has('mcp__slack__slack_update_canvas')).toBe(false);
    expect(Object.isFrozen(OUTBOX_TOOLS) && Object.isFrozen(OUTBOX_TOOLS.slack.write) && Object.isFrozen(OUTBOX_TOOLS.vdp.ops)).toBe(true);
    // never a delete, another generate (the DC note) or a stakeholder write
    for (const t of OUTBOX_ALLOWLIST) expect(t).not.toMatch(/__(delete_|generate_(?!use_case$)|create_stakeholder|update_stakeholder)/);
    expect(outboxAllowedTools('vdp', 'send')).toEqual([
      'mcp__vdp-app-fir__update_use_case',
      'mcp__vdp-app-fir__create_use_case',
      'mcp__vdp-app-fir__update_vdp_header',
      'mcp__vdp-app-fir__create_vdp',
      'mcp__vdp-app-fir__create_company',
      'mcp__vdp-app-fir__add_vdp_asset',
      'mcp__vdp-app-fir__set_vdp_owners',
      'mcp__vdp-app-fir__generate_use_case',
      'mcp__vdp-app-fir__get_use_case',
      'mcp__vdp-app-fir__get_vdp',
      'mcp__vdp-app-fir__get_vdp_assets',
      'mcp__vdp-app-fir__list_companies',
    ]);
  });

  it('read-back tools are reads, and everything else on those servers is refused', () => {
    expect(() => assertReadOnly([...OUTBOX_READ_TOOLS])).not.toThrow();
    for (const [server, tool] of [
      ['slack', 'slack_schedule_message'],
      ['slack', 'slack_update_canvas'],
      ['slack', 'slack_add_reaction'],
      ['mcp-adaptor', 'trash_message'],
      ['mcp-adaptor', 'set_drive_file_permissions'],
      ['mcp-adaptor', 'manage_gmail_label'],
      ['google_workspace_readonly', 'send_gmail_message'],
      ['vdp-app-fir', 'delete_use_case'],
      ['vdp-app-fir', 'generate_deal_contribution_notes'],
      ['vdp-app-fir', 'create_stakeholder'],
      ['vdp-app-fir', 'delete_stakeholder'],
      ['vdp-app-fir', 'delete_vdp'],
      ['vdp-app-fir', 'update_stakeholder'],
    ] as const) {
      expect(() => assertOutboxTool(server, tool, 'write')).toThrow(/not on the outbox write allowlist/);
      expect(() => assertOutboxTool(server, tool, 'read')).toThrow(/not on the outbox read allowlist/);
    }
    expect(() => assertOutboxTool('slack', 'slack_send_message', 'read')).toThrow();
    expect(outboxAllowedTools('slack', 'draft')).toEqual(['mcp__slack__slack_send_message_draft', 'mcp__slack__slack_read_thread']);
  });

  it('server declarations copy no secrets (headers, tokens, unknown env)', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beoutbox-')), 'claude.json');
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        mcpServers: {
          slack: { type: 'http', url: 'https://mcp.slack.com/mcp', headers: { Authorization: 'Bearer SECRET' }, oauth: { clientId: 'cid', callbackPort: 3118, clientSecret: 'SECRET' } },
          'mcp-adaptor': { type: 'stdio', command: '/opt/mcp-adaptor', args: ['serve'], env: { GW_PROFILE: 'sdb', MCP_ADAPTOR_ENV: 'prod', API_TOKEN: 'SECRET' } },
        },
      }),
    );
    const slack = resolveOutboxServer('slack', tmp);
    const gmail = resolveOutboxServer('gmail', tmp);
    expect(slack).toEqual({ type: 'http', url: 'https://mcp.slack.com/mcp', oauth: { clientId: 'cid', callbackPort: 3118 } });
    expect(gmail).toEqual({ type: 'stdio', command: '/opt/mcp-adaptor', args: ['serve'], env: { GW_PROFILE: 'sdb', MCP_ADAPTOR_ENV: 'prod' } });
    expect(JSON.stringify([slack, gmail])).not.toContain('SECRET');
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  });
});

describe('import boundaries', () => {
  const files = ['src', 'app', 'scripts', 'tools', 'tests'].flatMap((d) => walk(path.join(ROOT, d)));
  const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

  it('only src/outbox/** imports the outbox MCP config', () => {
    const offenders = files
      .filter((f) => !rel(f).startsWith('src/outbox/') && !rel(f).startsWith('tests/outbox/') && !rel(f).startsWith('tests/db/outbox/') && !rel(f).startsWith('tests/safety/'))
      .filter((f) => importsOf(f).some((s) => /(^|\/)outbox\/mcp-config(\.ts)?$/.test(s)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('the outbox index does not re-export it', () => {
    const idx = fs.readFileSync(path.join(ROOT, 'src/outbox/index.ts'), 'utf8');
    expect(importsOf(path.join(ROOT, 'src/outbox/index.ts')).filter((s) => s.includes('mcp-config'))).toEqual([]);
    expect(idx).not.toMatch(/export \*\s+from\s+['"]\.\/mcp-config/);
  });

  it('only src/outbox/** imports the VDP write transport, and only the VDP client and write files import its JSON-RPC core', () => {
    const writers = files.filter((f) => importsOf(f).some((s) => /connectors\/vdp\/write(\.ts)?$/.test(s) || (rel(f).startsWith('src/connectors/vdp/') && /^\.\/write(\.ts)?$/.test(s))));
    expect(writers.map(rel).filter((f) => !f.startsWith('src/outbox/') && !f.startsWith('tests/outbox/') && !f.startsWith('tests/db/outbox/') && !f.startsWith('tests/vdp/'))).toEqual([]);
    const core = files.filter((f) => importsOf(f).some((s) => /connectors\/vdp\/http(\.ts)?$/.test(s) || (rel(f).startsWith('src/connectors/vdp/') && /^\.\/http(\.ts)?$/.test(s))));
    expect(core.map(rel).filter((f) => !['src/connectors/vdp/client.ts', 'src/connectors/vdp/write.ts'].includes(f) && !f.startsWith('tests/'))).toEqual([]);
  });

  it('the scanner side (llm, scanner, connectors) never imports the outbox', () => {
    const offenders = files.filter((f) => /^src\/(llm|scanner|connectors)\//.test(rel(f))).filter((f) => importsOf(f).some((s) => /(^@\/outbox|\/outbox(\/|$))/.test(s)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('src/llm/mcp-config.ts declares no outbox write tool in an allowlist', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/llm/mcp-config.ts'), 'utf8');
    const scan = /SLACK_SCAN_TOOLS = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
    expect(scan).not.toMatch(/send|draft/);
  });
});

describe('D-56: the one live Slack send is the feedback report', () => {
  const CHANNEL = 'C0FEEDBACK01';
  const dest = (channelId = CHANNEL) => feedbackActionFor({ channelId, channelName: '#cc-feedback', text: '*Bug: placeholder*\nCUSTOMER_1 sees an empty Time page', title: 'Placeholder bug', kind: 'bug', report: null });
  const proofFor = (draftId: string, payload: Record<string, unknown>): DeliveryConfirmation =>
    confirmDelivery({ draftId, draftVersion: 1, mode: 'send', payloadHash: payloadHash(payload), confirmToken: 't', expectedToken: 't', at: '2026-11-11T12:00:00.000Z' });
  const sendCall = (channel_id = CHANNEL): ToolCall => ({ server: 'slack', tool: 'slack_send_message', args: { channel_id, message: 'x' } });

  it('without the feedback option (every caller but the worker) a feedback post fails closed', async () => {
    const t = liveOutboxTransport({ vdp: null, canvas: null });
    await expect(t.callTool(sendCall(), { channel: 'feedback' })).rejects.toThrow(OutboxLiveDisabledError);
  });

  it('posts once, through the gateway, only to the configured channel, only with the spent confirm', async () => {
    const fake = new FakeMcp();
    const gw = new OutboxGateway(liveOutboxTransport({ vdp: null, canvas: null, feedback: { channel: () => CHANNEL, transport: fake } }));
    const payload = actionPayloadFor(dest());
    const { call } = await gw.write({ draftId: 'd1', channel: 'feedback', mode: 'send', payload }, proofFor('d1', payload));
    expect(call).toEqual({ server: 'slack', tool: 'slack_send_message', args: { channel_id: CHANNEL, message: expect.stringContaining('CUSTOMER_1') } });
    expect(fake.calls.map((c) => [c.tool, c.args.channel_id])).toEqual([['slack_send_message', CHANNEL]]);
  });

  it('refuses another channel, a thread, a forged or unspent proof, and any other Slack send', async () => {
    const fake = new FakeMcp();
    const t = liveOutboxTransport({ vdp: null, canvas: null, feedback: { channel: () => CHANNEL, transport: fake } });
    const gw = new OutboxGateway(t);
    // a report staged to another channel than the configured one
    const other = actionPayloadFor(dest('C0SOMEWHERE9'));
    await expect(gw.write({ draftId: 'd2', channel: 'feedback', mode: 'send', payload: other }, proofFor('d2', other))).rejects.toThrow(/only the configured feedback channel/);
    // straight to the transport: no proof, a minted proof the gateway never spent, a proof spent on another call
    await expect(t.callTool(sendCall(), { channel: 'feedback' })).rejects.toThrow(/No confirm proof/);
    const payload = actionPayloadFor(dest());
    await expect(t.callTool(sendCall(), { channel: 'feedback', proof: proofFor('d3', payload) })).rejects.toThrow(/not spent by the Outbox gateway/);
    const spent = proofFor('d4', payload);
    await gw.write({ draftId: 'd4', channel: 'feedback', mode: 'send', payload }, spent);
    await expect(t.callTool({ ...sendCall(), args: { channel_id: CHANNEL, message: 'something else' } }, { channel: 'feedback', proof: spent })).rejects.toThrow(/differs from the one the confirm was spent on/);
    await expect(t.callTool({ ...sendCall(), args: { channel_id: CHANNEL, message: 'x', thread_ts: '1.2' } }, { channel: 'feedback', proof: spent })).rejects.toThrow(/top-level message/);
    // a normal Slack reply (channel `slack`), even into the feedback channel, stays fail-closed
    await expect(t.callTool(sendCall(), { channel: 'slack' })).rejects.toThrow(OutboxLiveDisabledError);
    await expect(t.callTool({ server: 'slack', tool: 'slack_send_message_draft', args: { channel_id: CHANNEL, message: 'x' } }, { channel: 'feedback' })).rejects.toThrow(OutboxLiveDisabledError);
    // posting switched off (no channel resolved) → refused before the inner transport
    const off = liveOutboxTransport({ vdp: null, canvas: null, feedback: { channel: () => null, transport: fake } });
    await expect(new OutboxGateway(off).write({ draftId: 'd5', channel: 'feedback', mode: 'send', payload }, proofFor('d5', payload))).rejects.toThrow(/posting feedback is off/);
    expect(fake.calls.filter((c) => c.tool === 'slack_send_message')).toHaveLength(1); // only d4's
  });

  it('the worker is the only place that wires the feedback relay', () => {
    const files = ['src', 'app', 'scripts'].flatMap((d) => walk(path.join(ROOT, d)));
    const wired = files.filter((f) => /liveOutboxTransport\(\{[^)]*feedback:/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
    expect(wired).toEqual(['src/worker/index.ts']);
  });
});
