/**
 * STRESS-2 (placeholders only): REC-1 records every Slack message the read tools return; the triage pass gives each
 * message to / from me one verdict; unsure verdicts escalate. A fake query() plays the CLI: it calls the runner's
 * PreToolUse and PostToolUse hooks and runs cc tools on the real in-process MCP server. Slack tool output is rendered
 * by the stress replay (the same format the real tool returns).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { parseSlackSearch, parseSlackThread, slackHints } from '../../../src/connectors/slack/parse';
import { AgentSdkSkillRunner, type QueryFn, type ScanSkillRunInput, type ScanSkillRunResultWithPasses } from '../../../src/llm/skill-runner';
import { restrictedTools } from '../../../src/llm/mcp-config';
import { queryClassOf } from '../../../src/llm/slack-rec';
import { FakeClock } from '../../../src/scanner/runtime/clock';
import { slackRecallDefaults } from '../../../src/scanner/runtime/connectors';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import { DEFAULT_TRIAGE, addresseeOf, broadcastOf, isTrivial, renderTriageBatch, selectSlackTriage, type TriageLine } from '../../../src/scanner/triage/slack-triage';
import type { NormalizedSourceItem } from '../../../src/scanner/types';
import { SlackReplay, addMessage, addThread, emptyIndex, markRecorded, type SlackIndex } from '../../../scripts/stress/replay/slack';
import { loadFixture } from '../runtime/helpers/slack-sim';
import { PROFILE } from '../runtime/helpers/world';

const ME = 'U0ME00001';
const WINDOW = { from: '2026-11-04T16:00:00.000Z', to: '2026-11-04T18:00:00.000Z' };
const T0 = Date.parse(WINDOW.from) / 1000;
const ts = (min: number) => `${T0 + min * 60}.000100`;

/** A small placeholder day: DMs to me, my promise in a channel thread, noise, a thread with my reply. */
function index(): SlackIndex {
  const ix = emptyIndex(ME);
  const dm = { channelId: 'D0DM00011', channelLine: 'DM (ID: D0DM00011)', participantsLine: `PERSON_A (ID: U0PERSONA), ME (ID: ${ME})` };
  const gdm = { channelId: 'C0GDM0001', channelLine: 'Group DM (ID: C0GDM0001)', participantsLine: `PERSON_B (ID: U0PERSONB), PERSON_C (ID: U0PERSONC), ME (ID: ${ME})` };
  const who = (id: string, name: string) => ({ authorId: id, authorName: name, authorEmail: `${name.toLowerCase()}@example.com` });
  const perma = (ch: string, t: string, thread?: string) => `https://example.slack.com/archives/${ch}/p${t.replace('.', '')}${thread ? `?thread_ts=${thread}&cid=${ch}` : ''}`;
  const add = (m: Parameters<typeof addMessage>[1], cls: string) => addMessage(ix, m, cls);
  add({ ...dm, ...who('U0PERSONA', 'PERSON_A'), ts: ts(5), permalink: perma(dm.channelId, ts(5)), text: "oh man ```remote: Write access to repository not granted. 403``` can you give me write access" }, 'dm');
  add({ ...dm, ...who(ME, 'ME'), ts: ts(9), permalink: perma(dm.channelId, ts(9)), text: 'added you, see https://docs.google.com/document/d/FILE_RUNBOOK_000000000001/edit' }, 'mine');
  add({ ...dm, ...who('U0PERSONA', 'PERSON_A'), ts: ts(12), permalink: perma(dm.channelId, ts(12)), text: 'thanks!! :raised_hands:' }, 'dm');
  add({ ...gdm, ...who('U0PERSONB', 'PERSON_B'), ts: ts(20), permalink: perma(gdm.channelId, ts(20)), text: 'are you able to present this afternoon at ACME? I need to know now' }, 'dm');
  add({ ...gdm, ...who('U0PERSONB', 'PERSON_B'), ts: ts(25), permalink: perma(gdm.channelId, ts(25)), text: 'PERSON_C can you resend the invite?' }, 'dm');
  const ch = { channelId: 'C0TEAMUPD', channelLine: '#team-updates (ID: C0TEAMUPD)' };
  add({ ...ch, ...who(ME, 'ME'), ts: ts(40), threadTs: ts(30), permalink: perma(ch.channelId, ts(40), ts(30)), text: 'Working on getting everything up-to-date today/tomorrow PERSON_D.' }, 'mine');
  addThread(ix, ch.channelId, ts(30), { ...ch, ...who('U0PERSOND', 'PERSON_D'), ts: ts(30), text: 'can someone refresh the Q3 numbers?' }, [
    { ...ch, ...who('U0PERSONE', 'PERSON_E'), ts: ts(35), text: 'not me' },
    { ...ch, ...who(ME, 'ME'), ts: ts(40), text: 'Working on getting everything up-to-date today/tomorrow PERSON_D.' },
  ]);
  for (const cls of ['dm', 'mentions', 'mine']) markRecorded(ix, cls, '2026-11-04');
  return ix;
}

function replay() {
  return new SlackReplay(index(), { now: () => Date.parse(WINDOW.to), zone: 'America/Denver' });
}

const search = (query: string, extra: Record<string, unknown> = {}) => ({
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

describe('Slack tool-output parser (REC-1)', () => {
  it('parses detailed search pages and detailed thread reads into messages', () => {
    const r = replay();
    const dms = parseSlackSearch(r.search(search(`-from:<@${ME}>`))).messages;
    expect(dms.map((m) => m.ts)).toEqual([ts(5), ts(12), ts(20), ts(25)]);
    expect(dms[0]).toMatchObject({ channelId: 'D0DM00011', channelType: 'im', authorId: 'U0PERSONA', authorName: 'PERSON_A' });
    expect(dms[0]!.text).toContain('can you give me write access');
    expect(dms[2]).toMatchObject({ channelId: 'C0GDM0001', channelType: 'mpim' });
    expect(dms[2]!.participants?.map((p) => p.externalId)).toEqual(['U0PERSONB', 'U0PERSONC', ME]);
    const mine = parseSlackSearch(r.search(search(`from:<@${ME}>`))).messages;
    const reply = mine.find((m) => m.channelId === 'C0TEAMUPD')!;
    expect(reply).toMatchObject({ channelType: 'channel', channelName: 'team-updates', threadTs: ts(30) });
    const th = parseSlackThread(r.readThread({ channel_id: 'C0TEAMUPD', message_ts: ts(30), limit: 30, response_format: 'detailed' }), 'C0TEAMUPD', ts(30)).messages;
    expect(th.map((m) => [m.ts, m.threadTs ?? null, m.authorId])).toEqual([
      [ts(30), null, 'U0PERSOND'],
      [ts(35), ts(30), 'U0PERSONE'],
      [ts(40), ts(30), ME],
    ]);
  });

  it('reads the recorded real-tool search shape (placeholder fixtures)', () => {
    const hits = parseSlackSearch(JSON.stringify(loadFixture<{ results: string }>('slack/search_to_me.detailed.v1.json'))).messages;
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ channelId: 'D0DM00009', authorId: 'U0PERSONA', ts: '1793893334.322509', text: 'added you to the oppty' });
    const t = parseSlackSearch(loadFixture<{ results: string }>('slack/search_thread_reply.detailed.v1.json')).messages;
    expect(t[0]!.threadTs).toBe('1793894585.289729');
  });

  it('extracts Drive refs, other URLs and Org62 ids; classifies the skill queries', () => {
    const h = slackHints('see https://docs.google.com/presentation/d/FILE_DECK_00000000000001/edit and https://example.com/a and opp 006XX000004TmiQAAS');
    expect(h.fileRefs).toEqual(['drive:FILE_DECK_00000000000001', 'url:https://example.com/a']);
    expect(h.oppHints).toEqual(['006XX000004TmiQAAS']);
    expect(queryClassOf(`-from:<@${ME}>`, ME)).toBe('dm');
    expect(queryClassOf(`<@${ME}>`, ME)).toBe('mentions');
    expect(queryClassOf(`from:<@${ME}>`, ME)).toBe('mine');
    expect(queryClassOf('in:#team-updates', ME)).toBe('channel');
  });

  it('classifies searches by filters and keywords; a mention in filters, or any unknown search, is "other"', () => {
    expect(queryClassOf({ filters: `-from:<@${ME}>` }, ME)).toBe('dm');
    expect(queryClassOf({ keywords: [`<@${ME}>`] }, ME)).toBe('mentions');
    expect(queryClassOf({ filters: `from:<@${ME}> has:file` }, ME)).toBe('mine');
    expect(queryClassOf({ filters: 'in:#team-updates' }, ME)).toBe('channel');
    expect(queryClassOf({ filters: `<@${ME}>` }, ME)).toBe('other');
    expect(queryClassOf({}, ME)).toBe('other');
    expect(queryClassOf({ keywords: ['pricing'] }, ME)).toBe('other');
    expect(queryClassOf('some text', ME)).toBe('other');
  });
});

// ------------------------------------------------------------------ fake CLI

type Step = { tool: string; input: Record<string, unknown> };
interface Script {
  traversal: Step[];
  triage?: (prompt: string) => Step[];
  escalate?: (prompt: string) => Step[];
}

function fakeCli(script: Script, r: SlackReplay, seen: { prompts: string[]; inputs: Record<string, unknown>[]; options: Options[] }): QueryFn {
  return ({ prompt, options }) => {
    seen.prompts.push(prompt);
    seen.options.push(options);
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
        const out = (await pre({ hook_event_name: 'PreToolUse', tool_name: step.tool, tool_input: step.input, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '' } as never, id, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; updatedInput?: Record<string, unknown> } };
        if (out.hookSpecificOutput?.permissionDecision === 'deny') continue;
        // Like the CLI: no hook decision → the canUseTool gate decides (and may rewrite the input).
        const gate = (await options.canUseTool!(step.tool, step.input, { signal: new AbortController().signal, toolUseID: id } as never)) as { behavior: string; updatedInput?: Record<string, unknown> } | null;
        if (gate?.behavior !== 'allow') continue;
        const input = gate.updatedInput ?? step.input;
        seen.inputs.push({ tool: step.tool, ...input });
        if (step.tool.startsWith('mcp__cc__')) {
          await client.callTool({ name: step.tool.slice('mcp__cc__'.length), arguments: input });
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

const finish: Step[] = [
  { tool: 'mcp__cc__cc_report_coverage', input: { windows: ['search:dm', 'search:mentions', 'search:mine'].map((ref) => ({ ref, from: WINDOW.from, to: WINDOW.to })) } },
  { tool: 'mcp__cc__cc_finish', input: { cursor: { value: `${T0 + 7200}.000000`, at: WINDOW.to }, complete: true } },
];

async function setup(triage: boolean, escalate: boolean) {
  const store = new InMemoryScannerStore({ clock: new FakeClock(WINDOW.to), profile: structuredClone(PROFILE) });
  const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: WINDOW });
  const context = await store.getContext({ connector: 'slack', scope: 'inbox' });
  const env = { CC_SLACK_TRIAGE: triage ? '1' : '0', CC_SLACK_ESCALATE: escalate ? '1' : '0' };
  const d = slackRecallDefaults(env);
  const input: ScanSkillRunInput = {
    skillPath: 'skills/scan-slack.md',
    model: 'claude-haiku-5-5',
    mcpServers: {},
    allowedTools: restrictedTools('slack').allowedTools,
    runId,
    context,
    maxTurns: 30,
    costCapUsd: 0.08,
    signal: new AbortController().signal,
    window: WINDOW,
    mode: 'incremental',
    ...(d.autoRecord ? { autoRecord: d.autoRecord } : {}),
    ...(d.triage ? { triage: d.triage('inbox', 'incremental') } : {}),
  };
  return { store, input, runId };
}

const traversal: Step[] = [
  { tool: 'mcp__slack__slack_search_public_and_private', input: search(`-from:<@${ME}>`) },
  { tool: 'mcp__slack__slack_search_public_and_private', input: search(`<@${ME}>`, { channel_types: 'public_channel,private_channel' }) },
  { tool: 'mcp__slack__slack_search_public_and_private', input: search(`from:<@${ME}>`) },
  { tool: 'mcp__slack__slack_read_thread', input: { channel_id: 'C0TEAMUPD', message_ts: ts(30), limit: 30, response_format: 'concise' } },
  // The traversal itself catches one ask, citing the message by channel:ts (no record call).
  { tool: 'mcp__cc__cc_propose_item', input: { kind: 'ask', title: 'Grant PERSON_A write access to the repo', confidence: 'sure', evidence: [{ sourceItemId: `D0DM00011:${ts(5)}`, role: 'origin', reason: 'pasted 403, asked for write access' }] } },
  // An agent re-record of an auto-recorded message keeps the runner's version and id.
  { tool: 'mcp__cc__cc_record_source_items', input: { items: [{ kind: 'message', externalId: `D0DM00011:${ts(12)}`, occurredAt: ts(12), excerpt: 'Thanks (paraphrased)' }] } },
  ...finish,
];

describe('REC-1 in the runner', () => {
  it('records every message the read tools return, deduped, before the agent links; thread reads are made detailed', async () => {
    const { store, input } = await setup(false, false);
    const seen = { prompts: [] as string[], inputs: [] as Record<string, unknown>[], options: [] as Options[] };
    const r = (await new AgentSdkSkillRunner({ queryFn: fakeCli({ traversal }, replay(), seen) }).run(input, store)) as ScanSkillRunResultWithPasses;
    expect(r.ok).toBe(true);
    // 4 DM-class + my 2 (one is also the thread reply) + thread parent and the other reply = 7 distinct messages.
    const keys = [`D0DM00011:${ts(5)}`, `D0DM00011:${ts(9)}`, `D0DM00011:${ts(12)}`, `C0GDM0001:${ts(20)}`, `C0GDM0001:${ts(25)}`, `C0TEAMUPD:${ts(30)}`, `C0TEAMUPD:${ts(35)}`, `C0TEAMUPD:${ts(40)}`];
    for (const k of keys) expect(store.getSourceItemByDedupe(`slack:${k}`), k).toBeTruthy();
    expect(r.passes?.[0]).toMatchObject({ pass: 'traversal', autoRecorded: keys.length, recErrors: 0 });
    expect(r.counts?.recorded).toBe(keys.length);
    const thanks = store.getSourceItemByDedupe(`slack:D0DM00011:${ts(12)}`)!;
    expect(JSON.stringify(thanks)).toContain('thanks!!'); // the verbatim tool text, not the agent's paraphrase
    const doc = store.getSourceItemByDedupe(`slack:D0DM00011:${ts(9)}`)!;
    expect(JSON.stringify(doc)).toContain('drive:FILE_RUNBOOK_000000000001');
    const reply = store.getSourceItemByDedupe(`slack:C0TEAMUPD:${ts(40)}`)!;
    expect(JSON.stringify(reply)).toContain(`slack:C0TEAMUPD:${ts(30)}`); // threadRef = the thread root
    expect(seen.inputs.find((i) => String(i.tool).endsWith('slack_read_thread'))).toMatchObject({ response_format: 'detailed' });
    expect(seen.prompts[0]).toContain('{{slack.rec}} = auto');
    const items = store.listWorkItems();
    expect(items).toHaveLength(1);
    expect(store.evidenceFor(items[0]!.workItemId)[0]!.sourceItemId).toBe(store.getSourceItemByDedupe(`slack:D0DM00011:${ts(5)}`)!.id);
    expect(seen.prompts).toHaveLength(1); // no triage pass when it is off
  });
});

describe('triage pass + escalation', () => {
  const triageSteps = (prompt: string): Step[] => {
    // The batch lists the VERDICT lines; the already-proposed ask shows as done.
    expect(prompt).toContain(`[D0DM00011:${ts(5)}]`);
    expect(prompt).toMatch(new RegExp(`\\[D0DM00011:${ts(5).replace('.', '\\.')}\\][^\\n]*done: proposed:`));
    expect(prompt).not.toMatch(new RegExp(`\\[D0DM00011:${ts(12).replace('.', '\\.')}\\][^\\n]*VERDICT`)); // trivial thanks
    return [
      { tool: 'mcp__cc__cc_propose_item', input: { kind: 'commitment', title: 'Update the Q3 numbers for PERSON_D', confidence: 'likely', evidence: [{ sourceItemId: `C0TEAMUPD:${ts(40)}`, role: 'origin', reason: 'my promise in the thread' }] } },
      {
        tool: 'mcp__cc__cc_triage_verdicts',
        input: {
          verdicts: [
            { id: `D0DM00011:${ts(9)}`, v: 'noise' },
            { id: `C0GDM0001:${ts(20)}`, v: 'unsure', why: 'who is you in the group DM' },
            { id: `C0GDM0001:${ts(25)}`, v: 'noise' },
            { id: `C0TEAMUPD:${ts(30)}`, v: 'noise', why: 'asked of anyone; my promise answers it' },
            { id: `C0TEAMUPD:${ts(35)}`, v: 'noise' },
            { id: `C0TEAMUPD:${ts(40)}`, v: 'act' },
          ],
        },
      },
    ];
  };

  it('gives each qualifying message one verdict, escalates the unsure ones, and tags pass writes', async () => {
    const { store, input } = await setup(true, true);
    const seen = { prompts: [] as string[], inputs: [] as Record<string, unknown>[], options: [] as Options[] };
    const escalate = (prompt: string): Step[] => {
      expect(prompt).toContain('first pass unsure: who is you in the group DM');
      expect((prompt.match(/ · VERDICT/g) ?? []).length).toBe(1); // only the escalated message needs a verdict
      return [
        { tool: 'mcp__cc__cc_propose_item', input: { kind: 'ask', title: 'Tell PERSON_B whether I can present at ACME today', confidence: 'sure', evidence: [{ sourceItemId: `C0GDM0001:${ts(20)}`, role: 'origin', reason: 'urgent direct question' }] } },
        { tool: 'mcp__cc__cc_triage_verdicts', input: { verdicts: [{ id: `C0GDM0001:${ts(20)}`, v: 'act' }] } },
      ];
    };
    const r = (await new AgentSdkSkillRunner({ queryFn: fakeCli({ traversal, triage: triageSteps, escalate }, replay(), seen) }).run(input, store)) as ScanSkillRunResultWithPasses;
    expect(r.ok).toBe(true);
    expect(seen.prompts).toHaveLength(3);
    // Triage passes see cc tools only: no Slack tools, no recording, no coverage, no cc_finish.
    const triOpts = seen.options[1]!;
    const gate = async (t: string) => (await triOpts.canUseTool!(t, {}, { signal: new AbortController().signal, toolUseID: 'g' } as never))?.behavior;
    for (const t of ['mcp__cc__cc_triage_verdicts', 'mcp__cc__cc_propose_item']) expect(await gate(t), t).toBe('allow');
    for (const t of ['mcp__slack__slack_search_public_and_private', 'mcp__cc__cc_finish', 'mcp__cc__cc_record_source_items']) expect(await gate(t), t).toBe('deny');
    expect(r.passes?.map((p) => p.pass)).toEqual(['traversal', 'triage', 'escalate']);
    expect(r.passes?.[1]).toMatchObject({ messages: 6, verdicts: { act: 1, noise: 4, unsure: 1, missing: 0 }, proposed: 1 });
    expect(r.passes?.[2]).toMatchObject({ messages: 1, verdicts: { act: 1, noise: 0, unsure: 0, missing: 0 }, proposed: 1, model: 'claude-sonnet-5-5' });
    expect(r.counts?.proposed).toBe(3);
    const titles = store.listWorkItems().map((w) => w.title).sort();
    expect(titles).toEqual(['Grant PERSON_A write access to the repo', 'Tell PERSON_B whether I can present at ACME today', 'Update the Q3 numbers for PERSON_D']);
    const reasons = store.allEvidence().map((e) => e.reason);
    expect(reasons.some((x) => x.startsWith('triage: '))).toBe(true);
    expect(reasons.some((x) => x.startsWith('escalate: '))).toBe(true);
  });

  it('TRI-NOISE: a later run over the same messages carries earlier verdicts forward: nothing is judged twice', async () => {
    const { store, input } = await setup(true, true);
    const seen = { prompts: [] as string[], inputs: [] as Record<string, unknown>[], options: [] as Options[] };
    const escalate = (): Step[] => [{ tool: 'mcp__cc__cc_triage_verdicts', input: { verdicts: [{ id: `C0GDM0001:${ts(20)}`, v: 'noise' }] } }];
    await new AgentSdkSkillRunner({ queryFn: fakeCli({ traversal, triage: triageSteps, escalate }, replay(), seen) }).run(input, store);
    const id = (ref: string) => store.getSourceItemByDedupe(`slack:${ref}`)!.id;
    const stored = await store.triageVerdicts([`D0DM00011:${ts(9)}`, `C0GDM0001:${ts(20)}`, `C0GDM0001:${ts(25)}`, `C0TEAMUPD:${ts(40)}`, `D0DM00011:${ts(5)}`].map(id));
    expect(stored.get(id(`C0GDM0001:${ts(20)}`))?.v).toBe('noise'); // the escalation's final call overwrote the first pass's unsure
    expect(stored.get(id(`C0GDM0001:${ts(25)}`))?.v).toBe('noise');
    expect(stored.get(id(`D0DM00011:${ts(5)}`))).toMatchObject({ v: 'act', why: 'linked' }); // linked by the traversal
    // The same window again (a re-read): the messages are unchanged, so their verdicts stand and no batch is needed.
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: WINDOW });
    const seen2 = { prompts: [] as string[], inputs: [] as Record<string, unknown>[], options: [] as Options[] };
    const r = (await new AgentSdkSkillRunner({ queryFn: fakeCli({ traversal: traversal.filter((x) => !x.tool.endsWith('cc_propose_item')), triage: () => [] }, replay(), seen2) }).run({ ...input, runId }, store)) as ScanSkillRunResultWithPasses;
    expect(r.ok).toBe(true);
    expect(seen2.prompts).toHaveLength(1); // the traversal only
    expect(r.passes?.[1]).toMatchObject({ pass: 'triage', messages: 0 });
  });

  it('without escalation, unsure (and unanswered) messages are flagged unlinked instead of vanishing', async () => {
    const { store, input } = await setup(true, false);
    const seen = { prompts: [] as string[], inputs: [] as Record<string, unknown>[], options: [] as Options[] };
    const r = (await new AgentSdkSkillRunner({ queryFn: fakeCli({ traversal, triage: triageSteps }, replay(), seen) }).run(input, store)) as ScanSkillRunResultWithPasses;
    expect(r.ok).toBe(true);
    expect(seen.prompts).toHaveLength(2);
    const unsure = store.getSourceItemByDedupe(`slack:C0GDM0001:${ts(20)}`)!;
    expect(store.unlinkedRow(unsure.id)?.reason).toMatch(/^triage: unsure: who is you/);
  });
});

describe('triage selection', () => {
  const mk = (ext: string, o: { me?: boolean; type?: string; toMe?: boolean; thread?: string; text?: string }): NormalizedSourceItem => ({
    connector: 'slack',
    kind: 'message',
    externalId: ext,
    dedupeKey: `slack:${ext}`,
    contentHash: ext,
    occurredAt: new Date(Number(ext.split(':')[1]) * 1000).toISOString(),
    author: { name: o.me ? 'ME' : 'PERSON_X', externalId: o.me ? ME : 'U0PERSONX', isMe: !!o.me },
    excerpt: o.text ?? 'can you look at this?',
    threadRef: `slack:${o.thread ?? ext}`,
    redacted: false,
    payload: { channelId: ext.split(':')[0], channelType: o.type ?? 'channel', ts: ext.split(':')[1], ...(o.toMe ? { toMe: true } : {}) },
  });

  it('keeps DMs, group DMs, my messages, mentions and my threads; skips trivial and handled ones; batches by conversation', () => {
    const items = [
      mk('D0A:100.1', { type: 'im' }),
      mk('D0A:101.1', { type: 'im', text: ':thumbsup:' }),
      mk('C0G:102.1', { type: 'mpim' }),
      mk('C0X:103.1', {}), // a channel message not involving me
      mk('C0X:104.1', { thread: 'C0X:104.1', toMe: true }),
      mk('C0X:105.1', { thread: 'C0X:104.1' }), // a reply in a thread I'm in
      mk('C0Y:106.1', { me: true }),
      mk('D0B:107.1', { type: 'im' }),
    ];
    const map = new Map(items.map((it) => [it.dedupeKey, it]));
    const ids = new Map(items.map((it) => [it.dedupeKey, `si_${it.externalId}`]));
    const outcomes = new Map([[`si_D0B:107.1`, ['proposed:wi_1:ask']]]);
    const sel = selectSlackTriage(map, ids, outcomes, { me: { userId: 'u', name: 'ME', slackId: ME } }, { batchSize: 3, maxBatches: 10 });
    expect(sel).toMatchObject({ qualifying: 7, trivial: 1, handled: 1, needing: 5, dropped: 0 });
    const needs = sel.batches.flatMap((b) => b.conversations.flatMap((c) => c.lines.filter((l) => l.needs).map((l) => l.ref)));
    expect(needs.sort()).toEqual(['C0G:102.1', 'C0X:104.1', 'C0X:105.1', 'C0Y:106.1', 'D0A:100.1']);
    expect(sel.batches.every((b) => b.needs <= 3)).toBe(true);
    const thread = sel.batches.flatMap((b) => b.conversations).find((c) => c.key === 'slack:C0X:104.1')!;
    expect(thread.lines.map((l) => l.ref)).toEqual(['C0X:104.1', 'C0X:105.1']); // one conversation, in order
  });

  it('isTrivial catches acknowledgements and emoji, not asks or promises', () => {
    for (const t of ['thanks!!', ':raised_hands:', 'lol', '👍', 'ok', 'Thank you so much']) expect(isTrivial(t), t).toBe(true);
    for (const t of ['will do', 'sure, tomorrow', 'can you share it?', 'Will take a look tonight.', 'yes']) expect(isTrivial(t), t).toBe(false);
  });

  it('addresseeOf reads leading @-mentions and name greetings (TRI-1: asks addressed to someone else)', () => {
    const me = { slackId: ME, name: 'ME Person' };
    expect(addresseeOf('Good morning Jay! I am having trouble moving my call', me)).toEqual(['Jay']);
    expect(addresseeOf('<@U0SAM|PERSON_S> Yes. It is on Wednesday. Can we connect?', me)).toEqual(['PERSON_S']);
    expect(addresseeOf('Hi <@U0ANA|PERSON_A>, I am the content lead', me)).toEqual(['PERSON_A']);
    expect(addresseeOf(`hello <@${ME}|ME Person> - have a minute?`, me)).toBe('me');
    expect(addresseeOf('Hi ME! quick one', me)).toBe('me');
    expect(addresseeOf('Could we bring that data in?', me)).toBeUndefined();
    expect(addresseeOf(`<@U0A|PERSON_A> <@${ME}|ME Person> can you look`, me)).toBe('me');
  });

  const gdm = (t: number, who: 'B' | 'C' | 'me', text: string): NormalizedSourceItem => ({
    ...mk(`C0GDM9:${t}.1`, { type: 'mpim', me: who === 'me', text }),
    author: who === 'me' ? { name: 'ME Person', externalId: ME, isMe: true } : { name: `PERSON_${who}`, externalId: `U0PERSON${who}`, isMe: false },
    threadRef: `slack:C0GDM9:${t}.1`,
  });
  const selectGdm = (items: NormalizedSourceItem[], opts: Parameters<typeof selectSlackTriage>[5] = {}) => {
    const map = new Map(items.map((it) => [it.dedupeKey, it]));
    const ids = new Map(items.map((it) => [it.dedupeKey, `si_${it.externalId}`]));
    return selectSlackTriage(map, ids, new Map(), { me: { userId: 'u', name: 'ME Person', slackId: ME } }, { batchSize: 10, maxBatches: 5 }, opts);
  };
  const rendered = (sel: ReturnType<typeof selectSlackTriage>) => sel.batches.map((b, i) => renderTriageBatch(b, { me: { userId: 'u', name: 'ME Person', slackId: ME } }, { index: i + 1, total: sel.batches.length })).join('\n');
  const lineOf = (text: string, ref: string) => text.split('\n').find((l) => l.includes(`[${ref}]`)) ?? '';

  it('TRI-2: an unaddressed follow-on in someone else\'s two-way exchange is theirs (a live shape)', () => {
    const items = [
      gdm(100, 'me', 'I can help with the ACME prep later today'),
      gdm(200, 'B', '<@U0PERSONC|PERSON_C> are you around to connect?'),
      gdm(300, 'C', '<@U0PERSONB|PERSON_B> I can do 12:30'),
      gdm(400, 'B', 'I can call you then, but most importantly - are you able to present this afternoon at ACME? I need to know now'),
      gdm(500, 'B', 'and can you send the deck before?'),
    ];
    const out = rendered(selectGdm(items));
    expect(lineOf(out, 'C0GDM9:400.1')).toContain('→ PERSON_C (not me: continues their exchange)');
    expect(lineOf(out, 'C0GDM9:500.1')).toContain('→ PERSON_C (not me: continues their exchange)'); // same author goes on
    expect(lineOf(out, 'C0GDM9:300.1')).toContain('→ PERSON_B (not me)');
  });

  it('TRI-2: an unaddressed reply right after my message to its author goes to me', () => {
    const items = [gdm(100, 'me', '<@U0PERSONB|PERSON_B> I can cover the demo part'), gdm(200, 'B', 'are you able to present this afternoon at ACME? I need to know now')];
    expect(lineOf(rendered(selectGdm(items)), 'C0GDM9:200.1')).toContain('→ me (replies to my message)');
    // In a 1:1 DM everything stays between me and them: no continuation is read.
    const dm = [
      { ...mk('D0ONE:100.1', { type: 'im', text: 'thoughts on the deck?' }), payload: { channelId: 'D0ONE', channelType: 'im', ts: '100.1', toMe: true } },
      { ...mk('D0ONE:200.1', { type: 'im', text: 'also the pricing' }), payload: { channelId: 'D0ONE', channelType: 'im', ts: '200.1', toMe: true } },
    ];
    expect(lineOf(rendered(selectGdm(dm)), 'D0ONE:200.1')).toContain('· PERSON_X → me ·');
  });

  it('TRI-3: @channel, @here and lists of three or more (me among them) are asks of a group, not of me', () => {
    expect(broadcastOf('<!here> can everyone add their forecast?', { slackId: ME })).toEqual({ to: 'channel' });
    expect(broadcastOf('@channel reminder: forecasts due Friday', { slackId: ME })).toEqual({ to: 'channel' });
    expect(broadcastOf(`<@U0A|PERSON_A> <@U0B|PERSON_B> <@${ME}|ME> please review by EOD`, { slackId: ME })).toEqual({ to: 'list', others: 2 });
    expect(broadcastOf(`<@U0A|PERSON_A> <@${ME}|ME> can you look`, { slackId: ME })).toBeUndefined(); // two people: still mine
    expect(broadcastOf('<@U0A|PERSON_A> <@U0B|PERSON_B> <@U0C|PERSON_C> can you look', { slackId: ME })).toBeUndefined(); // not me at all
    const out = rendered(selectGdm([gdm(100, 'B', `<@U0A|PERSON_A> <@U0C|PERSON_C> <@${ME}|ME> can you each send numbers?`), gdm(200, 'C', '<!here> can everyone add their Q4 forecast?')]));
    expect(lineOf(out, 'C0GDM9:100.1')).toContain('→ me and 2 others (a list)');
    expect(lineOf(out, 'C0GDM9:200.1')).toContain('→ everyone (@channel/@here)');
  });

  it('TRI-CTX: earlier runs\' lines of the conversation are context (before and after), never a VERDICT', () => {
    const own = [gdm(400, 'B', 'are you able to present this afternoon?')];
    const earlier: TriageLine[] = [
      { ref: 'C0GDM9:200.1', sourceItemId: 'si_C0GDM9:200.1', item: gdm(200, 'B', '<@U0PERSONC|PERSON_C> are you around to connect?'), needs: true },
      { ref: 'C0GDM9:300.1', sourceItemId: 'si_C0GDM9:300.1', item: gdm(300, 'C', '<@U0PERSONB|PERSON_B> I can do 12:30'), needs: true },
      { ref: 'C0GDM9:900.1', sourceItemId: 'si_C0GDM9:900.1', item: gdm(900, 'C', 'yes, I will present it'), needs: true },
    ];
    const sel = selectGdm(own, { extra: new Map([['dm:C0GDM9', earlier]]) });
    const out = rendered(sel);
    expect(sel.needing).toBe(1);
    expect(lineOf(out, 'C0GDM9:200.1')).toContain('context (earlier)');
    expect(lineOf(out, 'C0GDM9:900.1')).toContain('context (earlier)'); // the reply after, recorded by another run
    expect(lineOf(out, 'C0GDM9:400.1')).toContain('→ PERSON_C (not me: continues their exchange)'); // read with the earlier lines
    expect(lineOf(out, 'C0GDM9:400.1')).toContain('VERDICT');
    // Carried noise: a message an earlier run called noise is handled, not re-judged; it shows as context in its conversation.
    const prior = selectGdm(own, { prior: new Map([['si_C0GDM9:400.1', { v: 'noise' as const, why: 'asked of PERSON_C' }]]) });
    expect(prior).toMatchObject({ needing: 0, handled: 1 });
    const two = selectGdm([...own, gdm(450, 'B', 'PERSON_C, also can you send the deck?')], { prior: new Map([['si_C0GDM9:400.1', { v: 'noise' as const }]]) });
    expect(lineOf(rendered(two), 'C0GDM9:400.1')).toContain('done: noise:earlier run');
    expect(lineOf(rendered(two), 'C0GDM9:450.1')).toContain('VERDICT');
    // An earlier link (any non-context evidence) is handled too.
    expect(selectGdm(own, { prior: new Map([['si_C0GDM9:400.1', { v: 'act' as const, why: 'linked' }]]) })).toMatchObject({ needing: 0, handled: 1 });
  });

  it('TRI-CTX: the in-memory store reads a DM\'s and a thread\'s lines around a time, any window', async () => {
    const store = new InMemoryScannerStore({ clock: new FakeClock(WINDOW.to), profile: structuredClone(PROFILE) });
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: WINDOW });
    const msg = (ext: string, at: string, thread?: string): NormalizedSourceItem => ({ connector: 'slack', kind: 'message', externalId: ext, dedupeKey: `slack:${ext}`, contentHash: ext, occurredAt: at, excerpt: ext, threadRef: `slack:${thread ?? ext}`, redacted: false, payload: { channelId: ext.split(':')[0] } });
    await store.recordSourceItems(runId, [msg('D0CTX:1.1', '2026-11-01T10:00:00.000Z'), msg('D0CTX:2.1', '2026-11-02T10:00:00.000Z'), msg('D0CTX:3.1', '2026-11-03T10:00:00.000Z'), msg('D0CTX:9.1', '2026-11-09T10:00:00.000Z'), msg('C0T:5.1', '2026-11-05T10:00:00.000Z', 'C0T:4.1'), msg('C0T:6.1', '2026-11-06T10:00:00.000Z', 'C0X:1.1')]);
    const dm = await store.conversationLines({ channelId: 'D0CTX', before: { at: '2026-11-04T00:00:00.000Z', limit: 2 }, after: { at: '2026-11-05T00:00:00.000Z', limit: 4 } });
    expect(dm.map((l) => l.item.externalId)).toEqual(['D0CTX:2.1', 'D0CTX:3.1', 'D0CTX:9.1']);
    const th = await store.conversationLines({ threadRef: 'slack:C0T:4.1', before: { at: '2026-11-07T00:00:00.000Z', limit: 6 }, after: { at: '2026-11-07T00:00:00.000Z', limit: 4 } });
    expect(th.map((l) => l.item.externalId)).toEqual(['C0T:5.1']);
  });

  it('caps batches per run and reports the dropped remainder', () => {
    const items = Array.from({ length: 30 }, (_, i) => mk(`D0Z${i}:${200 + i}.1`, { type: 'im' }));
    const map = new Map(items.map((it) => [it.dedupeKey, it]));
    const ids = new Map(items.map((it) => [it.dedupeKey, `si_${it.externalId}`]));
    const sel = selectSlackTriage(map, ids, new Map(), { me: { userId: 'u', name: 'ME', slackId: ME } }, { ...DEFAULT_TRIAGE, batchSize: 10, maxBatches: 2 });
    expect(sel.batches).toHaveLength(2);
    expect(sel.dropped).toBe(10);
  });

  it('caps audit: by default every batch runs, none dropped (was 12 batches, the rest got no verdict)', () => {
    const items = Array.from({ length: 150 }, (_, i) => mk(`D1Z${i}:${300 + i}.1`, { type: 'im' }));
    const map = new Map(items.map((it) => [it.dedupeKey, it]));
    const ids = new Map(items.map((it) => [it.dedupeKey, `si_${it.externalId}`]));
    const sel = selectSlackTriage(map, ids, new Map(), { me: { userId: 'u', name: 'ME', slackId: ME } }, { ...DEFAULT_TRIAGE, batchSize: 10 });
    expect(sel.batches.length).toBeGreaterThan(12);
    expect(sel.batches.reduce((a, b) => a + b.needs, 0)).toBe(sel.needing);
    expect(sel.dropped).toBe(0);
  });
});
