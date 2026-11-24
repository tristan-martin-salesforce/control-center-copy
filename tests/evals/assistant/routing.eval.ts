/**
 * Routing goldens (D-81 Auto routing): every case through the real router, exact. The agreement prints at the end.
 * A miss is a router defect (fix the rule, amend D-81 in one line) or a case that encodes taste (fix the case).
 *
 * Post-2.0: a case after a step-stop runs through `routeChatTurn` with the stopped turn in the thread (the way both
 * DataSources route); a persona case also reads that persona's served catalog (`chatToolsFor`): the first tool the
 * fake model picks, and the views, pages and read routes it lists or withholds. A `fault` case is a known routing fault
 * (31-eval-goldens.md): it is expected to fail until the router is fixed.
 */
import { afterAll, describe, expect, it } from 'vitest';

import type { ChatMessage } from '@/contract';
import { chatToolsFor, type ServedTool } from '@/llm/chat/server';
import { routeTurn } from '@/llm/chat/router';
import { callChatTool, newToolState, PLAYBOOKS, type ChatToolCtx } from '@/llm/chat/tools';
import { STEP_LIMIT_CODE, stepLimitMessage } from '@/llm/chat/runner';
import { personaOf, type ResolvedPersona } from '@/personas';
import { routeChatTurn } from '@/server/chat/route';
import { appRouteCatalog } from '@/server/chat/app-routes';

import { pickFirstTool } from './picker';
import { ROUTING_CASES, type RoutingCase } from './routing.cases';

const label = (c: RoutingCase) =>
  `${c.text.split('\n')[0]!.slice(0, 60)}${c.text.includes('\n') ? ' …' : ''}${c.persona ? ` [${c.persona}]` : ''}${c.choice ? ` [choice ${c.choice}]` : ''}${c.setting ? ` [setting ${c.setting}]` : ''}${c.previous ? ` [after ${c.previous.intent}/${c.previous.tier}${c.previous.failed ? ' failed' : ''}]` : ''}${c.afterStepStop ? ` [after a step-stop ${c.afterStepStop.intent}/${c.afterStepStop.tier}]` : ''}${c.dayLeftUsd !== undefined ? ` [$${c.dayLeftUsd} left]` : ''}${c.fault ? ` [known fault ${c.fault}]` : ''}`;
let agreed = 0;
const faults = ROUTING_CASES.filter((c) => c.fault);

afterAll(() => console.log(`Assistant routing goldens: ${agreed}/${ROUTING_CASES.length - faults.length} agree, ${faults.length} known fault${faults.length === 1 ? '' : 's'} (${[...new Set(faults.map((c) => c.fault))].join(', ')})`));

/** The runner's step-stop, as the thread keeps it (src/llm/chat/runner.ts "Stopped after N steps"). */
function stoppedThread(c: NonNullable<RoutingCase['afterStepStop']>): Array<Pick<ChatMessage, 'role' | 'route' | 'text' | 'status' | 'parts'>> {
  const model = c.tier === 'fast' ? 'haiku' : c.tier === 'balanced' ? 'sonnet' : 'opus';
  const message = stepLimitMessage(200);
  return [
    { role: 'user', route: null, text: 'research everything we did with Globex this year', status: 'done', parts: [] },
    { role: 'assistant', route: { intent: c.intent, tier: c.tier, model, why: 'r', override: false }, text: 'Here is what I have so far.', status: 'error', parts: [{ type: 'error', error: { code: 'internal', message, retryable: true, details: { catalogCode: STEP_LIMIT_CODE } } }] },
  ] as never;
}

/** The playbooks a help description lists (after "a playbook to read before that work:"). */
const helpTopicsIn = (d: string) => (/playbook to read before that work: ([a-z_, ]+)\.$/.exec(d)?.[1] ?? '').split(/,\s*/).filter(Boolean);

const catalogs = new Map<string, { tools: ServedTool[]; names: Set<string> }>();
/** A persona's served tools, and every view, read page and read route they list. */
function catalogOf(id: 'se' | 'ae') {
  const hit = catalogs.get(id);
  if (hit) return hit;
  const p: ResolvedPersona = personaOf({ persona: { id } } as never);
  const tools = chatToolsFor(p);
  const query = tools.find((t) => t.name === 'query')!.description;
  const read = tools.find((t) => t.name === 'read')!.description;
  const views = [...query.matchAll(/^- ([a-z_0-9]+):/gm)].map((m) => m[1]!);
  const pages = /route = a page \(([^)]*)/.exec(read)![1]!.split(/,\s*/).map((x) => x.split(':')[0]!.trim());
  const routes = [...appRouteCatalog('read', p).matchAll(/^([A-Za-z0-9]+) (?:GET|POST|PATCH|PUT|DELETE) /gm)].map((m) => m[1]!);
  // the persona-resolved search / fetch sources and run kinds and jobs (P31-3): `search:vdp`, `fetch:vdp`, `run:syncForecast`
  const described = (name: string) => tools.find((t) => t.name === name)!.description;
  const runNames = [...described('run').matchAll(/\b(vdp_find_assets|syncForecast|checkMissingForecast|retryJob)\b/g)].map((m) => `run:${m[1]}`);
  const sources = [...(/\bvdp = /.test(described('search')) ? ['search:vdp'] : []), ...(/\bvdp \(ref = /.test(described('fetch')) ? ['fetch:vdp'] : [])];
  // plan, propose and help too (P31 follow-up 3): `plan:vdp_find_assets`, `propose:vdp`, `propose:use_case`, `help:vdp`,
  // and any forecast job one of them names (`plan:syncForecast`), which no persona's should
  const surfaceNames = (['plan', 'propose', 'help'] as const).flatMap((name) => {
    const d = described(name);
    return [
      ...[...d.matchAll(/\b(vdp_find_assets|syncForecast|checkMissingForecast)\b/g)].map((m) => `${name}:${m[1]}`),
      ...(name === 'propose' && /\bvdp = /.test(d) ? ['propose:vdp'] : []),
      ...(name === 'propose' && /\buse_case = /.test(d) ? ['propose:use_case'] : []),
      // help: every playbook its description lists (`help:dc`, `help:vdp`, `help:logging`, `help:lists`)
      ...(name === 'help' ? helpTopicsIn(d).map((t) => `help:${t}`) : []),
    ];
  });
  const out = { tools, names: new Set([...views, ...pages, ...routes, ...runNames, ...sources, ...surfaceNames]) };
  catalogs.set(id, out);
  return out;
}

async function check(c: RoutingCase) {
  const r = c.afterStepStop
    ? await routeChatTurn({ text: c.text, choice: c.choice ?? null, setting: c.setting ?? null, messages: stoppedThread(c.afterStepStop) })
    : routeTurn({ text: c.text, choice: c.choice ?? null, setting: c.setting ?? null, previous: c.previous ?? null, ...(c.dayLeftUsd !== undefined ? { dayLeftUsd: c.dayLeftUsd } : {}) });
  expect(r.model, `${c.why} (router: ${r.why})`).toBe(c.expect);
  if (c.intent) expect(r.intent, `${c.why} (router: ${r.why})`).toBe(c.intent);
  expect(r.why.length).toBeGreaterThan(3);
  if (c.persona) {
    const cat = catalogOf(c.persona);
    if (c.tool) {
      const p = pickFirstTool(c.text, cat.tools);
      expect(p.tool, `${c.why}; ranking ${p.ranking.slice(0, 3).map((x) => `${x.name} ${x.score}`).join(', ')}${p.via ? `; via ${p.via}` : ''}`).toBe(c.tool);
    }
    for (const n of c.offers ?? []) expect(cat.names.has(n), `${c.persona} offers ${n}: ${c.why}`).toBe(true);
    for (const n of c.withholds ?? []) expect(cat.names.has(n), `${c.persona} withholds ${n}: ${c.why}`).toBe(false);
  }
}

describe('Auto routing goldens', () => {
  it('cover every D-81 rule with 40+ cases, each with its one-line why', () => {
    expect(ROUTING_CASES.length).toBeGreaterThanOrEqual(40);
    for (const c of ROUTING_CASES) expect(c.why.length, c.text).toBeGreaterThan(5);
    const has = (f: (c: RoutingCase) => boolean) => ROUTING_CASES.some(f);
    expect(has((c) => c.expect === 'haiku' && !c.choice && !c.previous)).toBe(true); // short lookups
    expect(has((c) => c.text.split('\n').length > 6 && c.expect === 'sonnet')).toBe(true); // list mode
    expect(has((c) => c.expect === 'opus' && !c.choice)).toBe(true); // research and plans
    expect(has((c) => !!c.previous)).toBe(true); // follow-ups
    expect(has((c) => !!c.choice || !!c.setting)).toBe(true); // overrides
    expect(has((c) => c.dayLeftUsd !== undefined)).toBe(true); // budget nearly spent
    expect(has((c) => !!c.afterStepStop)).toBe(true); // continue after a step-stop
  });

  it('every persona case has its twin for the other persona (SE and Specialist AE side by side)', () => {
    const by = (p: 'se' | 'ae') => new Set(ROUTING_CASES.filter((c) => c.persona === p).map((c) => c.text));
    const [se, ae] = [by('se'), by('ae')];
    expect(se.size).toBeGreaterThanOrEqual(8);
    for (const t of se) if (!ROUTING_CASES.some((c) => c.text === t && c.persona === 'ae' && !c.fault)) expect.fail(`no AE twin for "${t.slice(0, 60)}"`);
    for (const t of ae) if (!se.has(t) && !ROUTING_CASES.some((c) => c.text === t && !c.persona)) expect.fail(`no SE twin for "${t.slice(0, 60)}"`);
  });

  it("D-55 (P31-3 and its follow-up): an AE's search, fetch, run, plan, propose and help never name VDP; an SE's never name the forecast jobs", () => {
    const gated = ['search', 'fetch', 'run', 'plan', 'propose', 'help'];
    const of = (id: 'se' | 'ae') => catalogOf(id).tools.filter((t) => gated.includes(t.name));
    expect(of('ae').map((t) => t.name).sort()).toEqual([...gated].sort());
    for (const t of of('ae')) expect(t.description, `ae ${t.name}`).not.toMatch(/\bvdp|okta\b/i);
    for (const t of of('se')) expect(t.description, `se ${t.name}`).not.toMatch(/syncForecast|checkMissingForecast/);
    for (const n of ['plan:vdp_find_assets', 'propose:vdp', 'propose:use_case', 'help:vdp']) {
      expect(catalogOf('se').names.has(n), `se offers ${n}`).toBe(true);
      expect(catalogOf('ae').names.has(n), `ae withholds ${n}`).toBe(false);
    }
    for (const id of ['se', 'ae'] as const) for (const n of catalogOf(id).names) expect(n, id).not.toMatch(/^(plan|propose|help):(syncForecast|checkMissingForecast)$/);
  });

  it("help's topics are the persona's (P31 eval note): the description, the served topic list and the playbooks agree", async () => {
    const served = async (id: 'se' | 'ae', topic?: string) => {
      const ctx = { host: {}, persona: personaOf({ persona: { id } } as never), input: { threadId: 't', messageId: 'm', userMessageId: 'u', text: 'how do I update a VDP?', context: [], model: 'haiku', signal: new AbortController().signal }, emit: () => {}, state: newToolState(), signal: new AbortController().signal, route: routeTurn({ text: 'how do I update a VDP?' }) } as unknown as ChatToolCtx;
      return (await callChatTool(ctx, 'help', topic ? { topic } : {})).text;
    };
    const want = { se: ['dc', 'vdp', 'logging', 'lists'], ae: ['logging', 'lists'] } as const;
    for (const id of ['se', 'ae'] as const) {
      const d = catalogOf(id).tools.find((t) => t.name === 'help')!.description;
      expect(helpTopicsIn(d), `${id} help description`).toEqual(want[id]);
      expect([...catalogOf(id).names].filter((n) => n.startsWith('help:')).sort(), id).toEqual(want[id].map((t) => `help:${t}`).sort());
      expect(await served(id), `${id} help with no topic`).toContain(`the playbooks ${want[id].join(', ')}.`);
      for (const t of PLAYBOOKS) {
        const text = await served(id, t);
        if ((want[id] as readonly string[]).includes(t)) expect(text, `${id} ${t}`).not.toMatch(/not active for your role|^No playbook/);
        else expect(text, `${id} ${t}`).toMatch(/^(VDP|Deal contributions) is not active for your role, so there is no [a-z]+ playbook to read \(Settings ▸ Role & rules lists it as available to activate\)\.$/);
      }
    }
  });

  it('the router is persona-blind: a persona twin routes to the same model', () => {
    for (const c of ROUTING_CASES.filter((x) => x.persona === 'ae')) {
      const twin = ROUTING_CASES.find((x) => x.text === c.text && x !== c && !x.fault);
      if (twin) expect(c.expect, c.text).toBe(twin.expect);
    }
  });

  const run = ROUTING_CASES.map((c) => [label(c), c] as const);
  it.each(run.filter(([, c]) => !c.fault))('%s', async (_l, c) => {
    await check(c);
    agreed += 1;
  });
  it.fails.each(run.filter(([, c]) => c.fault))('%s', async (_l, c) => {
    await check(c);
  });
});
