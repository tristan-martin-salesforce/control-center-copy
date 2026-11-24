/**
 * A placeholder Slack day and a fake `query()` that plays the CLI (PreToolUse hook → canUseTool gate → cc tools on the
 * real in-process MCP server, Slack tools rendered by the stress replay, a PostToolUse hook and the tool_result
 * message). Same shapes as tests/scanner/stress/rec1-triage.test.ts. No real names, ids or text.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { QueryFn } from '../../src/llm/skill-runner';
import { SlackReplay, addMessage, addThread, emptyIndex, markRecorded, type SlackIndex } from '../../scripts/stress/replay/slack';

export const ME = 'U0ME00001';
export const WINDOW = { from: '2026-11-04T16:00:00.000Z', to: '2026-11-04T18:00:00.000Z' };
const T0 = Date.parse(WINDOW.from) / 1000;
export const ts = (min: number) => `${T0 + min * 60}.000100`;
export const perma = (ch: string, t: string, thread?: string) => `https://example.slack.com/archives/${ch}/p${t.replace('.', '')}${thread ? `?thread_ts=${thread}&cid=${ch}` : ''}`;

function index(): SlackIndex {
  const ix = emptyIndex(ME);
  const dm = { channelId: 'D0DM00011', channelLine: 'DM (ID: D0DM00011)', participantsLine: `PERSON_A (ID: U0PERSONA), ME (ID: ${ME})` };
  const gdm = { channelId: 'C0GDM0001', channelLine: 'Group DM (ID: C0GDM0001)', participantsLine: `PERSON_B (ID: U0PERSONB), PERSON_C (ID: U0PERSONC), ME (ID: ${ME})` };
  const who = (id: string, name: string) => ({ authorId: id, authorName: name, authorEmail: `${name.toLowerCase()}@example.com` });
  const add = (m: Parameters<typeof addMessage>[1], cls: string) => addMessage(ix, m, cls);
  add({ ...dm, ...who('U0PERSONA', 'PERSON_A'), ts: ts(5), permalink: perma(dm.channelId, ts(5)), text: 'SECRET_TEXT_A can you give me write access to the repo' }, 'dm');
  add({ ...dm, ...who(ME, 'ME'), ts: ts(9), permalink: perma(dm.channelId, ts(9)), text: 'added you, see the runbook' }, 'mine');
  add({ ...dm, ...who('U0PERSONA', 'PERSON_A'), ts: ts(12), permalink: perma(dm.channelId, ts(12)), text: 'thanks!! :raised_hands:' }, 'dm');
  add({ ...gdm, ...who('U0PERSONB', 'PERSON_B'), ts: ts(20), permalink: perma(gdm.channelId, ts(20)), text: 'SECRET_TEXT_B are you able to present this afternoon at ACME?' }, 'dm');
  add({ ...gdm, ...who('U0PERSONB', 'PERSON_B'), ts: ts(25), permalink: perma(gdm.channelId, ts(25)), text: 'PERSON_C can you resend the invite?' }, 'dm');
  const ch = { channelId: 'C0TEAMUPD', channelLine: '#team-updates (ID: C0TEAMUPD)' };
  add({ ...ch, ...who(ME, 'ME'), ts: ts(40), threadTs: ts(30), permalink: perma(ch.channelId, ts(40), ts(30)), text: 'Working on getting everything up-to-date today PERSON_D.' }, 'mine');
  addThread(ix, ch.channelId, ts(30), { ...ch, ...who('U0PERSOND', 'PERSON_D'), ts: ts(30), text: 'can someone refresh the Q3 numbers?' }, [
    { ...ch, ...who('U0PERSONE', 'PERSON_E'), ts: ts(35), text: 'not me' },
    { ...ch, ...who(ME, 'ME'), ts: ts(40), text: 'Working on getting everything up-to-date today PERSON_D.' },
  ]);
  for (const cls of ['dm', 'mentions', 'mine']) markRecorded(ix, cls, '2026-11-04');
  return ix;
}

export const replay = () => new SlackReplay(index(), { now: () => Date.parse(WINDOW.to), zone: 'America/Denver' });

export const search = (query: string, extra: Record<string, unknown> = {}) => ({
  query,
  channel_types: query.startsWith('-from') ? 'im,mpim' : 'public_channel,private_channel,mpim,im',
  sort: 'timestamp',
  sort_dir: 'asc',
  limit: 20,
  after: String(T0 - 120),
  before: String(T0 + 7200),
  response_format: 'detailed',
  ...extra,
});

export type Step = { tool: string; input: Record<string, unknown> };
export interface Script {
  traversal: Step[];
  triage?: (prompt: string) => Step[];
  escalate?: (prompt: string) => Step[];
}

export function fakeCli(script: Script, r: SlackReplay, seen: { prompts: string[] } = { prompts: [] }): QueryFn {
  return ({ prompt, options }) => {
    seen.prompts.push(prompt);
    const steps = prompt.includes('escalation batch') ? (script.escalate?.(prompt) ?? []) : prompt.includes('triage batch') ? (script.triage?.(prompt) ?? []) : script.traversal;
    const gen = async function* (): AsyncGenerator<SDKMessage> {
      const cc = (options.mcpServers as Record<string, { instance: { connect: (t: unknown) => Promise<void> } }>).cc!.instance;
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await cc.connect(st);
      const client = new Client({ name: 'fake-cli', version: '1' });
      await client.connect(ct);
      yield { type: 'system', subtype: 'init', mcp_servers: [{ name: 'cc', status: 'connected' }], tools: [] } as unknown as SDKMessage;
      let n = 0;
      for (const step of steps) {
        n += 1;
        const id = `tu_${n}`;
        yield { type: 'assistant', message: { id: `msg_${n}`, model: options.model, content: [{ type: 'tool_use', id, name: step.tool, input: step.input }], usage: { input_tokens: 50, output_tokens: 40 } } } as unknown as SDKMessage;
        const pre = options.hooks!.PreToolUse![0]!.hooks[0]!;
        const out = (await pre({ hook_event_name: 'PreToolUse', tool_name: step.tool, tool_input: step.input, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '' } as never, id, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
        if (out.hookSpecificOutput?.permissionDecision === 'deny') continue;
        const gate = (await options.canUseTool!(step.tool, step.input, { signal: new AbortController().signal, toolUseID: id } as never)) as { behavior: string; updatedInput?: Record<string, unknown> } | null;
        if (gate?.behavior !== 'allow') continue;
        const input = gate.updatedInput ?? step.input;
        if (step.tool.startsWith('mcp__cc__')) {
          const res = (await client.callTool({ name: step.tool.slice('mcp__cc__'.length), arguments: input })) as { content?: unknown; isError?: boolean };
          yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: res.content ?? [], is_error: !!res.isError }] }, parent_tool_use_id: null } as unknown as SDKMessage;
          continue;
        }
        const text = step.tool.endsWith('slack_read_thread') ? r.readThread(input) : r.search(input);
        const response = [{ type: 'text', text }];
        const post = options.hooks?.PostToolUse?.[0]?.hooks[0];
        if (post) await post({ hook_event_name: 'PostToolUse', tool_name: step.tool, tool_input: input, tool_response: response, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '' } as never, id, { signal: new AbortController().signal });
        yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: response }] }, parent_tool_use_id: null } as unknown as SDKMessage;
      }
      yield { type: 'result', subtype: 'success', is_error: false, num_turns: n, result: 'DONE', total_cost_usd: 0.002, usage: { input_tokens: 100, output_tokens: 50 }, modelUsage: {}, permission_denials: [] } as unknown as SDKMessage;
      await client.close();
    };
    return gen();
  };
}

export const finish: Step[] = [
  { tool: 'mcp__cc__cc_report_coverage', input: { windows: ['search:dm', 'search:mentions', 'search:mine'].map((ref) => ({ ref, from: WINDOW.from, to: WINDOW.to })) } },
  { tool: 'mcp__cc__cc_finish', input: { cursor: { value: `${T0 + 7200}.000000`, at: WINDOW.to }, complete: true } },
];

export const traversal: Step[] = [
  { tool: 'mcp__slack__slack_search_public_and_private', input: search(`-from:<@${ME}>`) },
  { tool: 'mcp__slack__slack_search_public_and_private', input: search(`<@${ME}>`, { channel_types: 'public_channel,private_channel' }) },
  { tool: 'mcp__slack__slack_search_public_and_private', input: search(`from:<@${ME}>`) },
  { tool: 'mcp__slack__slack_read_thread', input: { channel_id: 'C0TEAMUPD', message_ts: ts(30), limit: 30, response_format: 'concise' } },
  { tool: 'mcp__cc__cc_propose_item', input: { kind: 'ask', title: 'Grant PERSON_A write access to the repo', confidence: 'sure', evidence: [{ sourceItemId: `D0DM00011:${ts(5)}`, role: 'origin', reason: 'pasted a 403, asked for write access' }] } },
  ...finish,
];

export const triageSteps = (): Step[] => [
  { tool: 'mcp__cc__cc_propose_item', input: { kind: 'commitment', title: 'Update the Q3 numbers for PERSON_D', confidence: 'likely', evidence: [{ sourceItemId: `C0TEAMUPD:${ts(40)}`, role: 'origin', reason: 'my promise in the thread' }] } },
  {
    tool: 'mcp__cc__cc_triage_verdicts',
    input: {
      verdicts: [
        { id: `D0DM00011:${ts(9)}`, v: 'noise' },
        { id: `C0GDM0001:${ts(20)}`, v: 'unsure', why: 'who is you in the group DM' },
        { id: `C0GDM0001:${ts(25)}`, v: 'noise', why: 'asks someone else' },
        { id: `C0TEAMUPD:${ts(30)}`, v: 'noise', why: 'asked of anyone; my promise answers it' },
        { id: `C0TEAMUPD:${ts(35)}`, v: 'noise' },
        { id: `C0TEAMUPD:${ts(40)}`, v: 'act', why: 'my promise' },
      ],
    },
  },
];

export const escalateSteps = (): Step[] => [
  { tool: 'mcp__cc__cc_propose_item', input: { kind: 'ask', title: 'Tell PERSON_B whether I can present at ACME today', confidence: 'sure', evidence: [{ sourceItemId: `C0GDM0001:${ts(20)}`, role: 'origin', reason: 'urgent direct question' }] } },
  { tool: 'mcp__cc__cc_triage_verdicts', input: { verdicts: [{ id: `C0GDM0001:${ts(20)}`, v: 'act', why: 'a direct question to me' }] } },
];
