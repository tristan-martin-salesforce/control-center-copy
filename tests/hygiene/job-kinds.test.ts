/**
 * HYG-1: no job is queued that no worker handles. Captures queued `enrich` for months with no handler, so every one
 * dead-lettered and every captured to-do stayed "enriching"; `agent.answer`, `tool.run` and `canvas.sync` were the
 * same. This is the creation-time guard: every `enqueueJob(…, { kind })` in src must name a kind the worker's
 * registry handles (the hygiene sweep cancels any that slip through at runtime).
 *
 * Also the Org62 cursor: the windowed Events and DCs reads go by SystemModstamp only, so an edit to an OLD record
 * (its SystemModstamp moves to now) falls in the next poll's window and is read.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../../src/jobs';
import { activitySyncJobDef } from '../../src/jobs/handlers/activity-sync';
import { settleJobDef } from '../../src/jobs/handlers/settle';
import { resolutionCheckJobDef } from '../../src/jobs/handlers/resolution-check';
import { vdpPushJobDef } from '../../src/jobs/handlers/vdp-push';
import { vdpAutopilotJobDef } from '../../src/jobs/handlers/vdp-autopilot';
import { outboxJobDef } from '../../src/outbox';
import { DEFAULT_MAINTENANCE } from '../../src/worker/schedules';
import { rerankJobDef } from '../../src/jobs/handlers/rerank';
import { priorityFeedbackJobDef } from '../../src/jobs/handlers/priority-feedback';
import { type JobHandlerDef } from '../../src/jobs';
import { reevaluateHandler } from '../../src/jobs/handlers/reevaluate';
import { jobPricing, LLM_JOB_KINDS, readInPrice } from '../../src/llm/spend';
import { readInModelFor } from '../../src/contract';

const ROOT = path.resolve(__dirname, '../..');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

/** The worker's registry as src/worker/index.ts builds it (deps are only used when a job runs). Keep in step with it. */
function workerKinds(): Set<string> {
  const r = createDefaultRegistry({});
  r.register(outboxJobDef({} as never));
  r.register(settleJobDef({} as never));
  r.register(resolutionCheckJobDef({} as never));
  r.register(activitySyncJobDef({} as never));
  r.register(vdpAutopilotJobDef({} as never));
  r.register(vdpPushJobDef({} as never));
  r.register(rerankJobDef({} as never)); // priority@2 R4
  r.register(priorityFeedbackJobDef()); // priority@2 R8
  return new Set(r.kinds());
}

describe('every job kind the code queues has a handler', () => {
  const src = files(path.join(ROOT, 'src')).map((f) => ({ f, text: readFileSync(f, 'utf8') }));
  // string constants (`export const SETTLE_JOB_KIND = 'settle.check'`) anywhere in src
  const consts = new Map<string, string>();
  for (const { text } of src) for (const m of text.matchAll(/(?:export )?const ([A-Z][A-Z0-9_]*)\s*=\s*'([a-z0-9_.]+)'/g)) consts.set(m[1]!, m[2]!);
  const queued: Array<{ file: string; kind: string }> = [];
  for (const { f, text } of src) {
    for (const m of text.matchAll(/enqueueJob\(\s*[\w.]+,\s*\{[^}]*?\bkind:\s*('([a-z0-9_.]+)'|([A-Z][A-Z0-9_]*))/g)) {
      const kind = m[2] ?? consts.get(m[3]!);
      if (kind) queued.push({ file: path.relative(ROOT, f), kind });
    }
  }

  it('finds the enqueue sites (the scan works)', () => {
    expect(queued.length).toBeGreaterThan(8);
    expect(queued.some((q) => q.kind === 'enrich')).toBe(true);
    expect(queued.some((q) => q.kind === 'hygiene.sweep')).toBe(true);
    expect(queued.some((q) => q.kind === 'org62.readback')).toBe(true);
  });

  it('each is registered with the worker (no dead-letter "no handler for …")', () => {
    const kinds = workerKinds();
    const missing = queued.filter((q) => !kinds.has(q.kind));
    expect(missing, missing.map((m) => `${m.kind} (${m.file})`).join('\n')).toEqual([]);
  });

  it('the scheduled kinds too, and the dead stubs are gone', () => {
    const kinds = workerKinds();
    for (const s of DEFAULT_MAINTENANCE) expect(kinds.has(s.kind), s.kind).toBe(true);
    const all = src.map((x) => x.text).join('\n');
    expect(all).not.toMatch(/kind: 'agent\.answer'/);
    expect(all).not.toMatch(/kind: 'canvas\.sync'/);
    expect(kinds.has('enrich')).toBe(true);
    expect(kinds.has('tool.run')).toBe(true);
  });
});

describe('the Org62 cursor sees edits to old records', () => {
  const skill = readFileSync(path.join(ROOT, 'skills/scan-org62.md'), 'utf8');
  const query = (from: string) => skill.split('\n').find((l) => l.startsWith('SELECT') && l.includes(`FROM ${from} WHERE`) && l.includes('{{window.fromSoql}}'));

  it.each(['Event', 'Deal_Contribution__c'])('the windowed %s read filters by SystemModstamp only, never by its own dates', (obj) => {
    const q = query(obj);
    expect(q, obj).toBeTruthy();
    expect(q).toMatch(/SystemModstamp >= \{\{window\.fromSoql\}\} AND SystemModstamp < \{\{window\.toSoql\}\}/);
    expect(q).toMatch(/ORDER BY SystemModstamp, Id/);
    expect(q).not.toMatch(/StartDateTime\s*[<>=]|CreatedDate\s*[<>=]|LastModifiedDate\s*[<>=]/);
  });
});

// LLM_JOB_KINDS (the start gate's table) names the real job kinds: a kind is listed exactly when its registry entry says
// `spends: true`, and a handler file that imports a model entry point or the spend envelope must flag its kind (job kinds chunk).
function workerRegistry() {
  const r = createDefaultRegistry({ scan: {} as never });
  r.wire('reevaluate', reevaluateHandler());
  const deps = {} as never;
  for (const d of [outboxJobDef(deps), vdpAutopilotJobDef(deps), vdpPushJobDef(deps), settleJobDef(deps), resolutionCheckJobDef(), rerankJobDef(deps), priorityFeedbackJobDef(), activitySyncJobDef(deps)] as JobHandlerDef[]) r.register(d);
  return r;
}

const HANDLERS = path.resolve(__dirname, '../../src/jobs/handlers');
/** A value import of one of these means the handler can call a model (or holds on the governor for one). */
const MODEL_ENTRY = /^import (?!type )[^;]*from '(@\/llm\/spend|@\/llm\/provider|@\/llm\/readin\/agent|@\/llm\/research\/[^']+|@\/scanner\/completion(\/llm)?|@\/server\/forecast\/draft|@\/server\/onboarding\/identity|\.\/relay-guard)';/m;

describe('LLM_JOB_KINDS names the real job kinds (the start gate)', () => {
  const r = workerRegistry();
  const spending = r.all().filter((d) => d.spends).map((d) => d.kind).sort();

  it('every listed kind is a registered handler that says it spends, and every spending handler is listed', () => {
    const listed = Object.keys(LLM_JOB_KINDS).sort();
    expect(listed.filter((k) => !r.get(k))).toEqual([]);
    expect(listed).toEqual(spending);
  });

  it('the two kinds the table named wrongly are the handlers’ own, and the gate holds them', () => {
    expect(r.get('readin.generate')?.spends).toBe(true);
    expect(r.get('vdp.assets.find')?.spends).toBe(true);
    expect(LLM_JOB_KINDS['readin.research']).toBeUndefined();
    expect(LLM_JOB_KINDS['vdp.assets']).toBeUndefined();
    expect(jobPricing({ kind: 'vdp.assets.find', payload: { key: 'x' } })).toEqual({ scope: 'research', skill: 'vdp-assets' });
    expect(jobPricing({ kind: 'readin.generate', payload: { entity_type: 'work_item', entity_id: 'x', trigger: 'top_rank' } })).toEqual({ scope: 'research', skill: 'readin-ask', model: readInModelFor('top_rank').model });
  });

  it('a read-in is priced as its handler holds it: the skill by entity type, the model by trigger', () => {
    expect(readInPrice({ entity_type: 'calendar_event', trigger: 'meeting_prep' })).toEqual({ skill: 'readin-meeting', model: readInModelFor('meeting_prep').model });
    expect(readInPrice({ entity_type: 'work_item', trigger: 'on_demand' })).toEqual({ skill: 'readin-ask', model: readInModelFor('on_demand').model });
    // an unknown trigger runs as on_demand in the handler (parsePayload), so it is priced so
    expect(readInPrice({ entity_type: 'work_item', trigger: 'nope' })).toEqual(readInPrice({ entity_type: 'work_item', trigger: 'on_demand' }));
  });

  it('a kind whose handler holds for itself is listed (crash recovery releases its holds) but the gate takes no hold for it', () => {
    expect(LLM_JOB_KINDS['use_cases.extract']?.startHold).toBe(false);
    expect(jobPricing({ kind: 'use_cases.extract' })).toBeNull();
    expect(jobPricing({ kind: 'backup.nightly' })).toBeNull();
  });

  it('a handler file that imports a model entry point or the spend envelope flags its kind', () => {
    const files = readdirSync(HANDLERS).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const calling = files.filter((f) => {
      const src = readFileSync(path.join(HANDLERS, f), 'utf8');
      return /JobHandlerDefs?\b/.test(src) && /\bkind: /.test(src) && MODEL_ENTRY.test(src);
    });
    expect(calling.length).toBeGreaterThan(10);
    const unflagged = calling.filter((f) => !readFileSync(path.join(HANDLERS, f), 'utf8').includes('spends: true'));
    expect(unflagged).toEqual([]);
    // and the other way: a flag in a file that calls no model is a mistake too
    const flaggedOnly = files.filter((f) => readFileSync(path.join(HANDLERS, f), 'utf8').includes('spends: true') && !calling.includes(f));
    expect(flaggedOnly).toEqual([]);
  });
});
