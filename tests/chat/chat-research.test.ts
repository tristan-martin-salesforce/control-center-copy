/**
 * `run research`: a question-scoped research run with the read-in agent's guards. Covers the research tools
 * (Calendar search filter and range limits, the finish call refusing links the run was never shown), the run itself
 * over a fake agent that executes the real tools, the chat tool (budget gate, one recorded spend line, mock mode
 * says it can't go live), and the turn deadline a long research run extends. Placeholder data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedEvent } from '@/connectors/google/parse';
import type { GoogleTools } from '@/connectors/google/client';
import { createFakeChatQuery } from '@/llm/chat/fake';
import { CHAT_TOOL_TIMEOUT_MS } from '@/llm/chat/server';
import { runChatTurn } from '@/llm/chat/runner';
import type { ChatUsageRecord } from '@/llm/chat/types';
import type { ResearchAgent, ResearchRunInput } from '@/llm/readin/agent';
import { CAL_PAGE, calendarLines, createResearchState, createResearchTools, listEventsInRange } from '@/llm/research/tools';
import { createChatHost } from '@/server/chat/host';
import { RESEARCH_RUNAWAY_TURNS, RESEARCH_TIMEOUT_MS, runChatResearch, type ChatResearchResult } from '@/server/chat/research';
import type { MockDataSource } from '@/server/datasource/mock';
import { collect, mockWith, of, textOf } from './helpers';

type G = { __ccDataSource?: unknown };
let ds: MockDataSource;
beforeEach(() => {
  ds = mockWith();
  (globalThis as G).__ccDataSource = ds;
});
afterEach(() => {
  delete (globalThis as G).__ccDataSource;
  ds.dispose();
});

const ev = (o: Partial<ParsedEvent> & { title: string; start: string }): ParsedEvent => ({
  id: o.title,
  startsRaw: o.start,
  endsRaw: o.start,
  end: o.start,
  allDay: false,
  description: '',
  location: '',
  attendeeEmails: [],
  attendees: [],
  attachments: [],
  ...o,
});

describe('research tools', () => {
  it('calendar lines keep only events mentioning every word, with attendee domains and links', () => {
    const events = [
      ev({ title: 'ACME workshop', start: '2025-03-12T15:00:00Z', attendeeEmails: ['a@acme.example', 'b@example.com'], link: 'https://calendar.example.com/e1' }),
      ev({ title: 'Team sync', start: '2025-03-13T15:00:00Z', description: 'nothing here' }),
      ev({ title: 'Prep', start: '2025-03-14T15:00:00Z', description: 'for the ACME renewal' }),
    ];
    expect(calendarLines(events, 'acme')).toEqual(['- 2025-03-12T15:00 · ACME workshop · with acme.example, example.com (https://calendar.example.com/e1)', '- 2025-03-14T15:00 · Prep']);
    expect(calendarLines(events, 'acme renewal')).toHaveLength(1);
    expect(calendarLines(events)).toHaveLength(3);
  });

  it('calendar search refuses a range over five years and says when Google is unavailable', async () => {
    const google: GoogleTools = { call: async () => 'No events found' } as unknown as GoogleTools;
    const state = createResearchState();
    const h = createResearchTools({ google }, state);
    expect((await h.research_calendar_search({ from: '2019-01-01', to: '2025-01-01' })).text).toMatch(/at most 1830 days/);
    expect((await h.research_calendar_search({ from: '2023-01-01', to: '2025-01-01' })).text).toMatch(/No events between 2023-01-01 and 2025-01-01/);
    expect((await h.research_calendar_search({ from: '2025-01-01', to: '2025-06-01', words: 'acme' })).text).toMatch(/No events mentioning "acme"/);
    const none = createResearchTools({ google: null }, createResearchState());
    expect((await none.research_calendar_search({ from: '2025-01-01', to: '2025-02-01' })).text).toMatch(/not available/);
  });

  /** A busy calendar behind a fake `get_events`: honours time_min/time_max and max_results like the read client. */
  const busyCalendar = (from: string, days: number, perDay: number) => {
    const all: Array<{ id: string; title: string; start: number }> = [];
    const t0 = Date.parse(`${from}T00:00:00Z`);
    for (let d = 0; d < days; d++) for (let i = 0; i < perDay; i++) all.push({ id: `ev${d}_${i}`, title: (d * perDay + i) % 7 === 0 ? `Fabrikam sync ${d}` : `Internal ${d}.${i}`, start: t0 + d * 86_400_000 + (8 + i) * 1_800_000 });
    const calls: Array<{ min: string; max: string }> = [];
    const google = {
      call: async (tool: string, a: { time_min: string; time_max: string; max_results: number }) => {
        expect(tool).toBe('get_events');
        calls.push({ min: a.time_min, max: a.time_max });
        const hit = all.filter((e) => e.start >= Date.parse(a.time_min) && e.start < Date.parse(a.time_max)).slice(0, a.max_results);
        if (!hit.length) return 'No events found';
        return hit.map((e) => `- "${e.title}" (Starts: ${new Date(e.start).toISOString()}, Ends: ${new Date(e.start + 1_800_000).toISOString()})\n  ID: ${e.id} | Link: https://calendar.example.com/${e.id}`).join('\n');
      },
    } as unknown as GoogleTools;
    return { all, calls, google };
  };

  it('ASSIST-5: a wide calendar search reads every event in the range (not the first 250), and says total and truncated', async () => {
    const cal = busyCalendar('2025-01-01', 200, 12); // 2,400 events, 372 per month: each month chunk comes back full and splits
    const want = cal.all.filter((e) => e.title.startsWith('Fabrikam')).length;
    expect(want).toBeGreaterThan(CAL_PAGE);
    const r = await listEventsInRange(cal.google, new Date('2025-01-01T00:00:00Z'), new Date('2025-07-19T23:59:59Z'));
    expect(r.events).toHaveLength(cal.all.length);
    expect(r.truncated).toBe(false);
    expect(new Set(r.events.map((e) => e.id)).size).toBe(cal.all.length);
    // through the tool: every match, with total= and truncated=false, paged by offset (never cut)
    const h = createResearchTools({ google: cal.google }, createResearchState());
    const first = await h.research_calendar_search({ from: '2025-01-01', to: '2025-07-19', words: 'fabrikam' });
    expect(first.text).toMatch(new RegExp(`^${want} event\\(s\\) mentioning "fabrikam" of ${cal.all.length} read .*total=${want}, truncated=false`));
    let text = first.text;
    let next = /read again with offset=(\d+)/.exec(first.text)?.[1];
    const callsAfterFirst = cal.calls.length;
    while (next) {
      const page = await h.research_calendar_search({ from: '2025-01-01', to: '2025-07-19', words: 'fabrikam', offset: Number(next) });
      text += page.text;
      next = /read again with offset=(\d+)/.exec(page.text)?.[1];
    }
    expect(new Set(text.match(/Fabrikam sync \d+/g)).size).toBe(new Set(cal.all.filter((e) => e.title.startsWith('Fabrikam')).map((e) => e.title)).size);
    expect(cal.calls.length).toBe(callsAfterFirst); // later pages read the copy fetched for page 1
  });

  it('a range busier than its cap says truncated and how far it read', async () => {
    const cal = busyCalendar('2025-01-01', 90, 12);
    const r = await listEventsInRange(cal.google, new Date('2025-01-01T00:00:00Z'), new Date('2025-03-31T23:59:59Z'), { cap: 400 });
    expect(r.truncated).toBe(true);
    expect(r.events.length).toBeGreaterThanOrEqual(400);
    expect(r.events.length).toBeLessThan(cal.all.length);
    expect(r.readTo.getTime()).toBeLessThan(Date.parse('2025-03-31T23:59:59Z'));
  });

  it('finish refuses a link the run was never shown, and accepts one it was', async () => {
    const state = createResearchState(['https://slack.example.com/archives/C1/p1']);
    const h = createResearchTools({}, state);
    const out = { answer: 'Yes: one thread.', findings: [{ text: 'A thread about the workshop', source: 'slack', permalink: 'https://made-up.example.com/x' }], searched: [{ source: 'slack', query: 'acme', hits: 1 }], notFound: [], confidence: 'likely' };
    expect((await h.research_finish(out)).isError).toBe(true);
    expect(state.output).toBeNull();
    const ok = await h.research_finish({ ...out, findings: [{ ...out.findings[0], permalink: 'https://slack.example.com/archives/C1/p1' }] });
    expect(ok.isError).toBeFalsy();
    expect(state.output?.answer).toBe('Yes: one thread.');
  });
});

/** A fake agent that runs the real local tools through `local.call`, as the model would. */
function fakeAgent(script: (call: NonNullable<NonNullable<ResearchRunInput['local']>['call']>, input: ResearchRunInput) => Promise<void>): ResearchAgent & { seen?: ResearchRunInput } {
  const a: ResearchAgent & { seen?: ResearchRunInput } = {
    async run(input) {
      a.seen = input;
      await script(input.local!.call!, input);
      const done = input.local!.done();
      return { ok: done, output: null, costUsd: 0.12, inputTokens: 9000, outputTokens: 700, turns: 4, toolCalls: ['mcp__cc_research__research_ledger_search', 'mcp__cc_research__research_finish'], ...(done ? {} : { error: { code: 'invalid_output', message: 'no finish', errorClass: 'unknown' as const } }) };
    },
  };
  return a;
}

describe('timeouts', () => {
  it('the chat tool server waits longer than a research run, so a long run is never cut off mid-way', () => {
    // A live run was cut at the old 60 s tool timeout and then cancelled when the turn ended.
    expect(CHAT_TOOL_TIMEOUT_MS).toBeGreaterThan(RESEARCH_TIMEOUT_MS + 10_000);
  });
});

describe('runChatResearch', () => {
  const db = { execute: async () => ({ rows: [{ name: 'PERSON_ME', system: 'org62_user', external_id: '005XX0000000MOCKAA' }] }) } as never;
  const base = { db, userId: 'u1', now: new Date('2026-11-10T20:00:00Z'), timezone: 'America/Denver', google: null, costCapUsd: 0.5, signal: new AbortController().signal, external: () => ({ servers: {}, tools: [], unavailable: ['Slack', 'Org62'] }) };

  it('runs the question-scoped skill with the research tools and returns the validated answer', async () => {
    const ledger = { search: async () => [{ kind: 'message' as const, at: '2025-03-12T15:00:00Z', label: '#acme-ext', text: 'Workshop recap', fromMe: true, permalink: 'https://slack.example.com/archives/C1/p1' }] };
    const agent = fakeAgent(async (call) => {
      await call('research_ledger_search', { text: 'ACME' });
      await call('research_finish', { answer: 'Yes: a workshop in March 2025.', findings: [{ text: 'Workshop recap you posted', source: 'slack', label: '#acme-ext', at: '2025-03-12', permalink: 'https://slack.example.com/archives/C1/p1' }], searched: [{ source: 'ledger', query: 'ACME', hits: 1 }], notFound: ['no Drive files'], confidence: 'sure' });
    });
    const r = await runChatResearch({ question: 'Have I done anything for ACME?', names: ['ACME'] }, { ...base, ledger, agent });
    expect(r.output?.answer).toBe('Yes: a workshop in March 2025.');
    expect(r.error).toBeUndefined();
    expect(r.unavailable).toEqual(expect.arrayContaining(['Slack', 'Org62', 'Gmail', 'Calendar']));
    expect(r.skill).toMatch(/^research-question@/);
    const sys = agent.seen!.systemPrompt.join('\n');
    expect(sys).toContain('"org62UserId":"005XX0000000MOCKAA"');
    expect(sys).toContain('"names":["ACME"]');
    expect(agent.seen!.local!.tools).toContain('mcp__cc_research__research_calendar_search');
    expect(agent.seen!.prompt).toContain('unavailable this run');
    // caps audit: the approved budget bounds the run, turns are a runaway guard only
    expect(agent.seen!.maxTurns).toBe(RESEARCH_RUNAWAY_TURNS);
    expect(agent.seen!.prompt).toContain('budget: $0.50');
    expect(agent.seen!.prompt).not.toMatch(/at most \d+ turns/);
    // the skill's words match the Run block: a cost budget, no turn budget (post-caps-ui)
    expect(sys).toContain('Stay inside the cost budget in the Run block.');
    expect(sys).not.toMatch(/turn and cost budget/);
  });

  it('a run that never finishes comes back as an error, not an answer', async () => {
    const r = await runChatResearch({ question: 'Anything for ACME?' }, { ...base, ledger: { search: async () => [] }, agent: fakeAgent(async () => undefined) });
    expect(r.output).toBeNull();
    expect(r.error?.code).toBe('invalid_output');
  });
});

describe('research in a chat turn: plan → Run → run research', () => {
  const answer: ChatResearchResult = {
    output: { answer: 'Yes: a workshop in March 2025.', findings: [{ text: 'Workshop recap', source: 'slack', permalink: 'https://slack.example.com/archives/C1/p1' }], searched: [{ source: 'slack', query: 'ACME', hits: 3 }], notFound: [], confidence: 'sure' },
    costUsd: 0.21,
    inputTokens: 20_000,
    outputTokens: 900,
    model: 'claude-sonnet-5-5',
    toolCalls: ['a', 'b', 'c'],
    unavailable: [],
    latencyMs: 600,
    skill: 'research-question@1',
  };
  const input = (text: string) => ({ threadId: 't1', messageId: 'm1', userMessageId: 'u1', text, context: [], model: 'sonnet' as const, signal: new AbortController().signal });

  it('the plan card waits for the answer (POST /chat/plan-answer); on Run, mock mode says live research is not available', async () => {
    const evs = await collect(ds.chat({ body: { text: 'Have I done anything for ACME in the past?', context: [] }, signal: new AbortController().signal } as never), {
      onEvent: (e) => {
        if (e.type === 'plan' && e.plan.status === 'waiting') void ds.chatPlanAnswer({ body: { planId: e.plan.id, answer: 'run' } } as never).then((r) => expect(r).toEqual({ delivered: true }));
      },
    });
    expect(of(evs, 'start')[0]!.route).toMatchObject({ intent: 'research', tier: 'strong', model: 'opus' });
    expect(of(evs, 'plan').map((e) => e.plan.status)).toEqual(['waiting', 'run']);
    const start = of(evs, 'tool-start').find((e) => e.name === 'research.search');
    expect(start).toBeTruthy();
    expect(of(evs, 'tool-result').find((e) => e.id === start!.id)).toMatchObject({ ok: false, summary: 'Live research not available here' });
    expect(textOf(evs)).toMatch(/couldn't research that live/);
    // the plan rides on the message, answered
    const thread = (await ds.listChatThreads({} as never)).threads.find((t) => t.isDefault)!.id;
    const msg = (await ds.getChatThread({ params: { id: thread } } as never)).messages.at(-1)!;
    expect(msg.parts.find((p) => p.type === 'plan')).toMatchObject({ plan: { status: 'run' } });
    // an answer for a plan no longer waiting says so
    expect(await ds.chatPlanAnswer({ body: { planId: of(evs, 'plan')[0]!.plan.id, answer: 'run' } } as never)).toEqual({ delivered: false });
  });

  it('a slow research run keeps the turn alive while it reports progress, records its spend once, and its answer reaches the reply', async () => {
    const usage: ChatUsageRecord[] = [];
    const b = ds.be6.backend();
    const host = createChatHost(ds, {
      ...b,
      recordUsage: async (u) => void usage.push(u),
      research: async (_i, o) => {
        for (let n = 0; n < 4; n++) {
          await new Promise((r) => setTimeout(r, 120));
          o.onTool?.('mcp__slack__slack_search_public_and_private');
        }
        return answer;
      },
    }, () => ds.now());
    const steps: Array<{ type: string; [k: string]: unknown }> = [];
    // The turn's no-progress watchdog (200 ms here) and the research's 120 ms steps share one fake clock, stepped 10 ms
    // at a time: on real timers a stalled event loop could fire the watchdog before the step that was due first.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      let done = false;
      const turn = (async () => {
        for await (const s of runChatTurn(input('Have I done anything for ACME in the past?'), host, { queryFn: createFakeChatQuery(), timeoutMs: 200, planAnswer: 'run', scanPollMs: 5 })) steps.push(s as never);
      })().finally(() => (done = true));
      for (let i = 0; i < 2_000 && !done; i++) await vi.advanceTimersByTimeAsync(10);
      await turn;
    } finally {
      vi.useRealTimers();
    }
    expect(steps.filter((s) => s.type === 'error')).toEqual([]);
    expect(steps.filter((s) => s.type === 'tool-progress').length).toBeGreaterThanOrEqual(4);
    const text = steps.filter((s) => s.type === 'text').map((s) => s.text).join('');
    expect(text).toContain('Yes: a workshop in March 2025.');
    expect(text).toContain('https://slack.example.com/archives/C1/p1');
    const research = usage.filter((u) => u.skill === 'research-question@1');
    expect(research).toHaveLength(1);
    expect(research[0]).toMatchObject({ costUsd: 0.21, status: 'ok', threadId: 't1' });
    // the tool row carries what the run cost on its own; the receipt counts it as a sub-run
    expect(steps.find((s) => s.type === 'tool-result' && s.costUsd === 0.21)).toBeTruthy();
    expect(steps.find((s) => s.type === 'usage')).toMatchObject({ usage: { subRunUsd: 0.21, tier: 'balanced' } }) // the input names Sonnet: the user's choice wins;
  });

  it('Skip on the plan card: nothing runs, and the answer says a run is waiting for a yes', async () => {
    const b = ds.be6.backend();
    let ran = false;
    const host = createChatHost(ds, { ...b, research: async () => ((ran = true), answer) }, () => ds.now());
    const steps: Array<{ type: string; [k: string]: unknown }> = [];
    for await (const s of runChatTurn(input('Have I done anything for ACME in the past?'), host, { queryFn: createFakeChatQuery(), planAnswer: 'skip', scanPollMs: 5 })) steps.push(s as never);
    expect(ran).toBe(false);
    expect(steps.filter((s) => s.type === 'plan').map((s) => (s.plan as { status: string }).status)).toEqual(['waiting', 'skipped']);
    expect(steps.filter((s) => s.type === 'text').map((s) => s.text).join('')).toMatch(/didn't run the research/);
    expect(steps.filter((s) => s.type === 'error')).toEqual([]);
  });
});
