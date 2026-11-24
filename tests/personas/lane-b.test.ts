/**
 * Lane B (D-55): the scanners, logging, gates and Settings follow the persona. Placeholders only.
 *  - AE: no VDP fetcher planned, no VDP tool or read page, no Health row, Time tab or Outbox item; they come back when
 *    VDP is activated (no restart: the runtime reloads the persona on every plan pass).
 *  - AE batch: Sales Events, no task type needed, the persona's caps.
 *  - Persona switch: reseeds the policy as a new version, Undo restores it, the record-type cache is cleared.
 *  - Prompt cache: the scanner's static prefix is byte-identical for SE and AE; only the Persona block differs.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { Draft, Settings } from '@/contract';
import { loggingProfile, personaTargetH, SE_LOGGING } from '@/engines/activity/persona';
import { renderWorkOrder, eventRow } from '@/engines/activity/slackbot';
import { gapRuleOn } from '@/engines/home/build';
import { nbaVerbAllowed, nbaVerbsFor } from '@/engines/nba/prompt/verbs';
import { chatToolsFor } from '@/llm/chat/server';
import { CHAT_TOOLS } from '@/llm/chat/tools';
import { loadSkill, scannerSystemPrompt, commonSkillPathFor } from '@/llm/skill-loader';
import { checkVdp } from '@/ops/doctor';
import { connectorRowsFor, draftHasSurface, personaOf, renderPersonaBlock } from '@/personas';
import { ORG62_SCOPE_MULTIPLIER } from '@/scanner/runtime/cadence';
import { deterministicSpec, org62PersonaVars, org62ScopesFor, org62Spec } from '@/scanner/runtime/connectors';
import { ScannerRuntime } from '@/scanner/runtime/scanner-runtime';
import { InMemoryScannerStore } from '@/scanner/store-memory';
import type { DeterministicFetcher, ScanContext, SkillRunner } from '@/scanner/types';
import { chatPageCatalog, chatReadPagesFor } from '@/server/chat/read';
import { isRecordTypeKv, RECORD_TYPE_KV, RECORD_TYPE_SOQL, recordTypeKv, recordTypeSoql } from '@/server/chat/record-type';
import { createMockDataSource } from '@/server/datasource/mock';

const SE = personaOf({ profile: { role: 'se_ic' } });
const AE = personaOf({ persona: { id: 'ae' } });
const AE_VDP = personaOf({ persona: { id: 'ae', features: { vdp: true } } });
const AE_DC = personaOf({ persona: { id: 'ae', features: { dealContributions: true, missedOpps: true } } });

const ctx = (persona?: ScanContext['persona']): ScanContext => ({ scope: { connector: 'org62', scope: 'opps' }, cursor: null, gaps: [], me: { userId: 'u', name: 'PERSON_ME' }, watchList: [], aliases: { accounts: [], channels: [] }, openItems: [], initiatives: [], skillVersion: '', ...(persona ? { persona } : {}) });

describe('Org62 scopes from the persona', () => {
  it('SE: all five; AE: opps, events, book; activating DCs and missed opps brings their scopes back', () => {
    expect(org62Spec().scopes(ctx(SE))).toEqual(['opps', 'events', 'dcs', 'book', 'missed_opps']);
    expect(org62Spec().scopes(ctx(AE))).toEqual(['opps', 'events', 'book']);
    expect(org62ScopesFor(AE_DC)).toEqual(['opps', 'events', 'dcs', 'book', 'missed_opps']);
    // every scope a persona can scan has a cadence
    for (const s of org62ScopesFor(AE_DC)) expect(ORG62_SCOPE_MULTIPLIER[s]).toBeGreaterThan(0);
  });

  it("the AE's book is opps I own and opp-team ones; the SE's is opp teams with DCs", () => {
    expect(org62PersonaVars(undefined)).toEqual({ 'org62.book': 'team_member', 'org62.dcs': 'on' });
    expect(org62PersonaVars(SE)).toEqual({ 'org62.book': 'team_member', 'org62.dcs': 'on' });
    expect(org62PersonaVars(AE)).toEqual({ 'org62.book': 'both', 'org62.dcs': 'off' });
    expect(org62Spec().scopeVars('book', ctx(AE))).toMatchObject({ 'org62.book': 'both', 'org62.dcs': 'off' });
    expect(org62Spec().scopeVars('book', ctx(SE))).toMatchObject({ 'org62.book': 'team_member', 'org62.dcs': 'on' });
  });
});

describe('the runtime follows the persona on every plan pass', () => {
  const runner: SkillRunner = { run: async () => ({ ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 }) } as unknown as SkillRunner;
  const vdpFetcher: DeterministicFetcher = { connector: 'vdp', scopes: async () => ['mine'], fetch: async () => ({ items: [], coverage: [], nextCursor: { value: '', at: new Date().toISOString() }, complete: true }), health: async () => ({ state: 'ok', checkedAt: new Date().toISOString() }) } as unknown as DeterministicFetcher;
  const make = (persona: ReturnType<typeof personaOf>) => {
    const store = new InMemoryScannerStore({ profile: { me: { userId: 'u', name: 'PERSON_ME', org62UserId: '005XX0000000OWNAAA' }, persona } });
    const rt = new ScannerRuntime({ store, runner, specs: [org62Spec({ mcpServers: () => ({}) }), deterministicSpec(vdpFetcher)], reevaluate: async () => {}, firstScan: null, scopeRefreshMs: 24 * 3600_000 });
    return { store, rt };
  };
  const planned = (jobs: Awaited<ReturnType<ScannerRuntime['planJobs']>>) => [...new Set(jobs.filter((j) => j.kind === 'scan').map((j) => `${(j as { connector: string }).connector}:${(j as { scope: string }).scope}`))].sort();

  it('AE: no VDP source and no dcs / missed_opps; activating VDP and DCs brings them back without a restart', async () => {
    const { store, rt } = make(AE);
    expect(planned(await rt.planJobs())).toEqual(['org62:book', 'org62:events', 'org62:opps']);
    expect(rt.connectorActive('vdp')).toBe(false);
    store.setPersona(personaOf({ persona: { id: 'ae', features: { vdp: true, dealContributions: true } } }));
    const next = planned(await rt.planJobs());
    expect(next).toContain('vdp:mine');
    expect(next).toContain('org62:dcs');
    expect(next).not.toContain('org62:missed_opps');
  });

  it('SE → AE: the dropped scopes and VDP pause (no jobs, no coverage gaps); nothing is deleted, and they resume', async () => {
    const { store, rt } = make(SE);
    expect(planned(await rt.planJobs())).toEqual(['org62:book', 'org62:dcs', 'org62:events', 'org62:missed_opps', 'org62:opps', 'vdp:mine']);
    store.setPersona(AE);
    await rt.planJobs();
    const st = rt.status();
    expect(st.filter((s) => s.paused === 'persona').map((s) => `${s.connector}:${s.scope}`).sort()).toEqual(['org62:dcs', 'org62:missed_opps', 'vdp:mine']);
    expect(st.filter((s) => s.paused === 'persona').every((s) => !s.catchingUp)).toBe(true);
    // a job queued before the switch does nothing
    expect((await rt.executeJob({ kind: 'scan', id: 'j1', connector: 'org62', scope: 'dcs', window: { from: '2026-11-10T00:00:00.000Z', to: '2026-11-10T01:00:00.000Z' }, mode: 'incremental', trigger: 'schedule', priority: 1, runAt: '2026-11-10T01:00:00.000Z' } as never)).status).toBe('skipped');
    // the reconciler's coverage-gap pass sees only the persona's scopes
    const r = await rt.reconciler.run({ kind: 'reconcile', id: 'r', passes: ['coverage_gaps'], trigger: 'reconcile', priority: 1, runAt: new Date().toISOString() } as never, new AbortController().signal);
    expect(r.findings.filter((f) => f.scope === 'dcs' || f.scope === 'missed_opps' || f.connector === 'vdp')).toEqual([]);
    store.setPersona(SE);
    await rt.planJobs();
    expect(rt.status().some((s) => s.paused === 'persona')).toBe(false);
  });
});

describe('the Persona block and the prompt cache', () => {
  it('the scanner static prefix is byte-identical for SE and AE; the Persona block follows the boundary', () => {
    for (const path of ['skills/scan-org62.md', 'skills/scan-slack.md', 'skills/scan-gmail.md', 'skills/triage-slack.md']) {
      const skill = loadSkill(path);
      const common = loadSkill(commonSkillPathFor(path));
      const se = scannerSystemPrompt(common.body, skill.body, ctx(SE), '<<BOUNDARY>>');
      const ae = scannerSystemPrompt(common.body, skill.body, ctx(AE), '<<BOUNDARY>>');
      const hash = (s: string) => createHash('sha256').update(s).digest('hex');
      expect(hash(se[0]!)).toBe(hash(ae[0]!));
      expect(se[1]).toBe('<<BOUNDARY>>');
      expect(se[2]).toContain(renderPersonaBlock(SE));
      expect(ae[2]).toContain(renderPersonaBlock(AE));
      expect(se[0]).not.toMatch(/## Persona\n/);
      // no persona in the context: the SE's block (as before personas)
      expect(scannerSystemPrompt(common.body, skill.body, ctx(), '<<BOUNDARY>>')[2]).toContain(renderPersonaBlock(SE));
    }
  });

  it("no skill names the owner; the preambles point at the Persona block", () => {
    // the user is {{me.name}} wherever a skill names them (`npm run scan:private` guards against real names)
    for (const p of ['skills/scan-claude-sessions.md', 'skills/scan-gemini-notes.md']) expect(readFileSync(p, 'utf8'), p).toContain('{{me.name}}');
    for (const p of ['skills/scan-claude-sessions.md', 'skills/scan-gemini-notes.md', 'skills/_scanner-common.md', 'skills/nba-common.md', 'skills/readin-ask.md', 'skills/readin-meeting.md', 'skills/research-question.md', 'skills/vdp-assets.md']) {
      const body = readFileSync(p, 'utf8');
      expect(body, p).not.toMatch(/for one Salesforce Solutions Engineer/);
    }
    expect(loadSkill('skills/scan-org62.md').body).toContain('{{org62.book}}');
  });

  it('NBA verbs: no update_vdp without VDP', () => {
    expect(nbaVerbsFor(SE)).toContain('update_vdp');
    expect(nbaVerbsFor(AE)).not.toContain('update_vdp');
    expect(nbaVerbAllowed('update_vdp', AE_VDP)).toBe(true);
    expect(nbaVerbAllowed('log_activity', AE)).toBe(true);
  });
});

describe('AE: no VDP surface until activated', () => {
  it('the Assistant: tools and read pages filtered by persona only, one stable list each', () => {
    const names = (p?: ReturnType<typeof personaOf>) => chatToolsFor(p).map((t) => t.name);
    expect(names(SE)).toEqual(CHAT_TOOLS.map((t) => t.name));
    expect(names(undefined)).toEqual(CHAT_TOOLS.map((t) => t.name));
    // Assistant v2: the same eleven tools for everyone; the VDP views and pages follow the persona's gates
    expect(names(AE)).toEqual(names(SE));
    const query = (p: ReturnType<typeof personaOf>) => chatToolsFor(p).find((t) => t.name === 'query')!.description;
    expect(query(AE)).not.toMatch(/vdp_records/);
    expect(query(AE_VDP)).toMatch(/vdp_records/);
    expect(chatReadPagesFor(AE)).not.toContain('vdp');
    expect(chatReadPagesFor(AE)).not.toContain('missed_opps');
    expect(chatReadPagesFor(SE)).toContain('vdp');
    expect(chatPageCatalog(AE)).not.toMatch(/^vdp:/m);
    const aeRead = chatToolsFor(AE).find((t) => t.name === 'read')!;
    expect(aeRead.description).not.toMatch(/vdp_detail/);
    expect(JSON.stringify(chatToolsFor(AE).map((t) => [t.name, t.description]))).toBe(JSON.stringify(chatToolsFor(personaOf({ persona: { id: 'ae' } })).map((t) => [t.name, t.description])));
  });

  it('Health rows, Outbox items and the doctor', async () => {
    const rows = [{ id: 'slack' }, { id: 'vdp' }, { id: 'gemini' }, { id: 'claude' }, { id: 'devbar' }];
    expect(connectorRowsFor(rows, SE).map((r) => r.id)).toEqual(['slack', 'vdp', 'gemini', 'claude', 'devbar']);
    expect(connectorRowsFor(rows, AE).map((r) => r.id)).toEqual(['slack', 'gemini', 'claude', 'devbar']);
    expect(connectorRowsFor(rows, AE_VDP).map((r) => r.id)).toContain('vdp');
    // db rows have uuid ids: the source decides
    expect(connectorRowsFor([{ id: '00000000-0000-0000-0000-000000000001', source: 'vdp' }, { id: '00000000-0000-0000-0000-000000000002', source: 'claude' }], AE).map((r) => r.source)).toEqual(['claude']);
    const vdpDraft = { destination: { kind: 'action', action: 'vdp.update_use_case' } };
    const canvas = { destination: { kind: 'action', action: 'slack_canvas.create' } };
    expect(draftHasSurface(vdpDraft, AE)).toBe(false);
    expect(draftHasSurface(vdpDraft, AE_VDP)).toBe(true);
    expect(draftHasSurface(canvas, AE)).toBe(true);
    // the doctor: VDP is skipped for a persona without it (and a warning, never a failure, with it)
    const rowsFor = (persona: unknown) => async () => [{ key: 'settings.persona', value: persona }];
    const c = (persona: unknown) => ({ env: { HOME: '/nonexistent' }, now: () => Date.now(), withDb: (_d: string, fn: (q: unknown) => unknown) => fn(rowsFor(persona)) }) as never;
    expect((await checkVdp(c({ version: 1, id: 'ae' }))).status).toBe('skip');
    expect((await checkVdp(c({ version: 1, id: 'se' }))).status).toBe('warn');
  });

  it('mock: Health, the Outbox, Home and Time follow a persona switch, and VDP comes back when activated', async () => {
    const ds = createMockDataSource();
    const before = await ds.getHealth({} as never);
    expect(before.connectors.map((c) => c.id)).toContain('vdp');
    const s0 = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s0.persona.version, value: { id: 'ae' } } } as never);
    const ae = await ds.getHealth({} as never);
    expect(ae.connectors.map((c) => c.id)).not.toContain('vdp');
    // nor in the summary (the sidebar's "VDP needs re-auth", the health dot, "n of m live")
    expect(ae.summary.broken.map((b) => b.id)).not.toContain('vdp');
    expect(ae.summary.total).toBe(ae.connectors.length);
    expect(before.summary.broken.map((b) => b.id)).toContain('vdp');
    const today = await ds.getToday({} as never);
    expect(JSON.stringify(today.header.catchUp ?? {})).not.toContain('"vdp"');
    const home = await ds.getHome({ query: { wide: true } } as never);
    const gaps = home.sections.flatMap((x) => x.rows).filter((r) => r.id.startsWith('gap:')).map((r) => r.id);
    expect(gaps).not.toContain('gap:connector:vdp');
    expect(gaps).not.toContain('gap:missed_dc');
    expect(gaps).not.toContain('gap:quarter_log');
    const week = await ds.getTime({ query: {} } as never);
    expect(week.quarter.targetH).toBe(0); // the AE has no hours target
    const outbox = await ds.getOutbox({} as never);
    expect(JSON.stringify(outbox)).not.toMatch(/"action":"vdp\./);
    const s1 = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s1.persona.version, value: { features: { vdp: true } } } } as never);
    expect((await ds.getHealth({} as never)).connectors.map((c) => c.id)).toContain('vdp');
  });

  it('Home gap rules: the preset plus activated features', () => {
    expect(gapRuleOn('missed_dc', SE)).toBe(true);
    expect(gapRuleOn('missed_dc', AE)).toBe(false);
    expect(gapRuleOn('missed_dc', AE_DC)).toBe(true);
    expect(gapRuleOn('quarter_log', SE)).toBe(true);
    expect(gapRuleOn('quarter_log', AE)).toBe(false); // no hours target
    expect(gapRuleOn('org62_unlogged', AE)).toBe(true);
    expect(gapRuleOn('missed_dc', undefined)).toBe(true);
  });
});

describe('AE logging: Sales Events, no task type, no hour caps', () => {
  const AE_LOG = loggingProfile(AE);

  it('the profile and the record-type lookup and cache, per record type', () => {
    expect(SE_LOGGING).toMatchObject({ recordTypeName: 'Solutions Event', taskTypeRequired: true, hoursTargetH: 250 });
    // 2026-11-14: no hour caps for any persona (grounded in truth)
    expect(SE_LOGGING).not.toHaveProperty('caps');
    expect(AE_LOG).not.toHaveProperty('caps');
    expect(AE_LOG).toMatchObject({ recordType: { field: 'DeveloperName', value: 'SalesEvents' }, recordTypeName: 'Sales Events', taskTypeRequired: false, hoursTargetH: null });
    expect(RECORD_TYPE_SOQL).toBe("SELECT Id, Name FROM RecordType WHERE SobjectType = 'Event' AND Name = 'Solutions Event' AND IsActive = true LIMIT 2");
    expect(recordTypeSoql(AE_LOG.recordType)).toBe("SELECT Id, Name FROM RecordType WHERE SobjectType = 'Event' AND DeveloperName = 'SalesEvents' AND IsActive = true LIMIT 2");
    expect(recordTypeKv(SE_LOGGING.recordType)).toBe(RECORD_TYPE_KV);
    expect(recordTypeKv(AE_LOG.recordType)).not.toBe(RECORD_TYPE_KV);
    expect(isRecordTypeKv(recordTypeKv(AE_LOG.recordType))).toBe(true);
    expect(personaTargetH(AE, 250)).toBe(0);
    expect(personaTargetH(SE, 250)).toBe(250);
  });

  it('the work order names Sales Events and asks for no task type', () => {
    const row = eventRow({ id: 'act-1', subject: 'ACCOUNT_1 | Discovery', start: '2026-11-04T16:00:00-07:00', end: '2026-11-04T17:00:00-07:00', durationH: 1, taskType: '', whatOrg62Id: '006XX0000000OPPAAA', origin: 'calendar' });
    const md = renderWorkOrder({ ownerName: 'PERSON_ME', ownerOrg62Id: '005XX0000000OWNAAA', recordTypeId: '012XX0000000RTYAAA', generatedAt: '2026-11-10T20:00:00.000Z', events: [row], updates: [], sourceLabel: 'Command Center', logging: { recordTypeName: 'Sales Events', taskTypeRequired: false } });
    expect(md).toContain('RecordTypeId `012XX0000000RTYAAA` (Sales Events)');
    expect(md).not.toContain('(Solutions Event)');
    expect(md).toContain('Leave SE_Task_Type__c empty.');
    expect(md).not.toMatch(/are NOT duplicates/);
  });

  it('mock batch for an AE: rows without a task type are logged as Sales Events', async () => {
    const ds = createMockDataSource();
    const s0 = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s0.persona.version, value: { id: 'ae' } } } as never);
    const r = await ds.stageLogBatch({ body: { includeProposed: true } } as never);
    expect(r.entity.skipped.every((x) => !/task type/.test(x.why))).toBe(true);
    const drafts = (await ds.getOutbox({} as never)) as unknown as { groups: unknown };
    void drafts;
    if (r.entity.draftIds.length) {
      const d = (await ds.getDraft({ params: { id: r.entity.draftIds[0]! } } as never)) as unknown as { draft?: Draft } & Draft;
      const text = JSON.stringify(d);
      expect(text).toContain('(Sales Events)');
      expect(text).not.toContain('(Solutions Event)');
    }
  });
});

describe('switching persona (mock)', () => {
  it('reseeds the starter policy as a new version, Undo restores it, and the record-type override is cleared', async () => {
    const ds = createMockDataSource();
    const s0: Settings = await ds.getSettings({} as never);
    // a record-type id the SE set by hand
    await ds.patchSettings({ params: { section: 'time' }, body: { ifVersion: s0.time.version, value: { logging: { ...s0.time.logging, org62RecordTypeId: '012XX0000000RTYAAA' } } } } as never);
    const s1: Settings = await ds.getSettings({} as never);
    expect(s1.time.logging.org62RecordTypeId).toBe('012XX0000000RTYAAA');
    const r = await ds.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s1.persona.version, value: { id: 'ae' } } } as never);
    const s2: Settings = await ds.getSettings({} as never);
    expect(s2.persona.id).toBe('ae');
    expect(s2.policy.version).toBe(s1.policy.version + 1);
    expect(s2.policy.role).toBe('ae');
    expect(s2.policy.name).toBe('Specialist AE');
    expect(s2.time.logging.org62RecordTypeId).toBeNull();
    const versions = await ds.getPolicyVersions({} as never);
    expect(versions.versions.map((v) => v.version)).toContain(s1.policy.version);
    // Undo: persona, policy and the override all back
    await ds.undoAudit({ params: { id: r.auditId! } } as never);
    const s3: Settings = await ds.getSettings({} as never);
    expect(s3.persona.id).toBe(s1.persona.id);
    expect(s3.policy).toEqual(s1.policy);
    expect(s3.time.logging.org62RecordTypeId).toBe('012XX0000000RTYAAA');
  });

  it('any other persona edit keeps the policy', async () => {
    const ds = createMockDataSource();
    const s0: Settings = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s0.persona.version, value: { thresholds: { missedOppMinAmountUsd: 25000 } } } } as never);
    const s1: Settings = await ds.getSettings({} as never);
    expect(s1.policy).toEqual(s0.policy);
  });
});
