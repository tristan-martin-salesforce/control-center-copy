/**
 * First-scan noise fixes (placeholders only): bare due dates (DUE-1), due already past when found (PAST-1), the same
 * deliverable twice in one conversation (DUP-1), suggested items in the completion pass (CMP-SUG), Settings ▸ Scanning
 * gates on proposals (NOT-MINE, TRI-3, GEM-CATCHUP, ORG-SPEED), mapping questions only for my asks and commitments
 * (MAP-1), Slack authors resolved to people (PPL-1) and credential redaction (RED-1). Memory store, then the db store on
 * a scratch database.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redact as connectorRedact } from '../../../src/connectors/redact';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { createRunState, dueArg, proposalGate } from '../../../src/llm/cc-tools/handlers';
import { redact as llmRedact } from '../../../src/llm/redact';
import { STILL_NEEDED_MARK, isStillNeeded, pastDueOnArrival } from '../../../src/engines/still-needed';
import { FakeClock } from '../../../src/scanner/runtime/clock';
import { slackSpec } from '../../../src/scanner/runtime/connectors';
import { parseDue, sameDeliverable } from '../../../src/scanner/propose-rules';
import { Reconciler, mappingQuestionFor } from '../../../src/scanner/reconcile/reconciler';
import { DbScannerStore } from '../../../src/scanner/store-db';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import { DEFAULT_SCANNING_PREFS, type NormalizedSourceItem, type ScanContext, type ScannerStore } from '../../../src/scanner/types';
import { planScrub } from '../../../scripts/db/scrub-credentials';
import { ScriptedSkillRunner } from '../../scanner/runtime/helpers/scripted-runner';
import { PROFILE } from '../../scanner/runtime/helpers/world';
import { pgAvailable, provisionTestDb, type TestDb } from './helpers/pg';

// The db-store cases run many queries; under the full suite's load 5 s is too short (they take well under 1 s alone).

const NOW = '2026-11-09T16:00:00.000Z'; // Mon 09:00 Denver
const TZ = 'America/Denver';
const W = { from: '2026-11-09T14:00:00.000Z', to: NOW };
const ME = 'U0PLACEME';

let n = 0;
/** A Slack message from PERSON_x (or me) in DM `dm`, `minAgo` minutes before NOW. */
const msg = (o: { dm?: string; who?: string; me?: boolean; text?: string; at?: string; type?: 'im' | 'mpim' | 'channel' }): NormalizedSourceItem => {
  n += 1;
  const ch = o.dm ?? 'D0NOISE01';
  const ts = `17938${String(10_000 + n).padStart(5, '0')}.000100`;
  return {
    connector: 'slack',
    kind: 'message',
    externalId: `${ch}:${ts}`,
    dedupeKey: `slack:${ch}:${ts}`,
    contentHash: `h${n}`,
    occurredAt: o.at ?? new Date(Date.parse(NOW) - (100 - n) * 60_000).toISOString(),
    excerpt: o.text ?? 'can you send the ACME pricing deck?',
    author: o.me ? { name: 'ME Person', externalId: ME, isMe: true } : { name: o.who ?? 'PERSON_B', externalId: `U0${(o.who ?? 'PERSON_B').replace(/[^A-Z0-9]/g, '')}`, isMe: false },
    threadRef: `slack:${ch}:${ts}`,
    redacted: false,
    payload: { channelId: ch, channelType: o.type ?? 'im', ts, ...(o.me ? {} : { toMe: true }) },
  };
};

async function propose(store: ScannerStore, it: NormalizedSourceItem, p: { kind?: 'ask' | 'commitment' | 'training'; title: string; due?: string; confidence?: 'sure' | 'likely' | 'guess' }) {
  const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'catch_up', window: W });
  const [r] = await store.recordSourceItems(runId, [it]);
  const out = await store.proposeItem(runId, { kind: p.kind ?? 'ask', title: p.title, ...(p.due ? { due: p.due } : {}), evidence: [{ sourceItemId: r!.sourceItemId, role: 'origin', reason: 'asked in a DM' }], confidence: p.confidence ?? 'sure' });
  return { ...out, sourceItemId: r!.sourceItemId, runId };
}

describe('pure rules', () => {
  it('DUE-1: a bare date is 17:00 local; a zone-less time is local; an explicit zone is kept', () => {
    expect(new Date(parseDue('2026-11-12', TZ)).toISOString()).toBe('2026-11-13T00:00:00.000Z'); // 17:00 MST
    expect(new Date(parseDue('2026-07-01', TZ)).toISOString()).toBe('2026-07-01T23:00:00.000Z'); // 17:00 MDT
    expect(new Date(parseDue('2026-11-12T09:30', TZ)).toISOString()).toBe('2026-11-12T16:30:00.000Z');
    expect(new Date(parseDue('2026-11-12T09:30:00Z', TZ)).toISOString()).toBe('2026-11-12T09:30:00.000Z');
    expect(parseDue('next week', TZ)).toBeNaN();
    // The cc tool passes a bare date through so the store reads it in my timezone (before: UTC midnight).
    expect(dueArg('2026-11-12')).toBe('2026-11-12');
    expect(dueArg('1793800000')).toBe(new Date(1793800000 * 1000).toISOString());
  });

  it('PAST-1: past when first seen (beyond a 2 h grace) lands as Still needed?', () => {
    expect(pastDueOnArrival({ dueAt: '2026-10-20T23:00:00.000Z', firstSeenAt: NOW })).toBe(true);
    expect(pastDueOnArrival({ dueAt: new Date(Date.parse(NOW) - 30 * 60_000).toISOString(), firstSeenAt: NOW })).toBe(false); // a few minutes late: live
    expect(pastDueOnArrival({ dueAt: '2026-11-12T00:00:00.000Z', firstSeenAt: NOW })).toBe(false);
  });

  it('DUP-1: two titles are one deliverable on shared words (the person aside)', () => {
    expect(sameDeliverable('Send PERSON_B the ACME pricing deck', 'Share the ACME pricing deck with PERSON_B')).toBe(true);
    expect(sameDeliverable('Send PERSON_B the ACME pricing deck', 'Review PERSON_B contract redlines', new Set(['person_b']))).toBe(false);
    expect(sameDeliverable('Send the deck to PERSON_B', 'Book PERSON_B a room', new Set(['person_b']))).toBe(false);
  });

  it('MAP-1: a mapping question only for my asks and commitments (Slack or Gmail), per the setting', () => {
    expect(mappingQuestionFor({ connector: 'slack', toMe: true, reason: 'x' }, 'mine')).toBe(true);
    expect(mappingQuestionFor({ connector: 'gmail', fromMe: true, reason: 'x' }, 'mine')).toBe(true);
    expect(mappingQuestionFor({ connector: 'slack', reason: 'an FYI about ACME' }, 'mine')).toBe(false);
    expect(mappingQuestionFor({ connector: 'drive', fromMe: true, reason: 'edited by me' }, 'mine')).toBe(false);
    expect(mappingQuestionFor({ connector: 'drive', reason: 'x' }, 'all')).toBe(true);
    expect(mappingQuestionFor({ connector: 'slack', toMe: true, reason: 'x' }, 'never')).toBe(false);
    // R9: a relink that judged it not actionable for me ends it, even under "all".
    expect(mappingQuestionFor({ connector: 'slack', toMe: true, reason: 'not actionable: PERSON_A cc’d me on the INITECH SOW' }, 'mine')).toBe(false);
    expect(mappingQuestionFor({ connector: 'slack', toMe: true, reason: 'Not actionable: an FYI' }, 'all')).toBe(false);
  });
});

describe('proposal gates (Settings ▸ Scanning)', () => {
  const state = (connector: 'slack' | 'gemini_notes' | 'calendar' | 'org62', items: NormalizedSourceItem[], scanning = DEFAULT_SCANNING_PREFS) => {
    const ctx = { scope: { connector, scope: 'inbox' }, cursor: null, gaps: [], me: { userId: 'u', name: 'ME Person', slackId: ME }, watchList: [], aliases: { accounts: [], channels: [] }, openItems: [], initiatives: [], skillVersion: '', scanning } as ScanContext;
    const st = createRunState({ runId: 'r', connector, window: W, context: ctx });
    for (const it of items) {
      st.items.set(it.dedupeKey, it);
      st.recorded.set(it.dedupeKey, `si_${it.externalId}`);
    }
    return st;
  };
  const origin = (it: NormalizedSourceItem) => [{ sourceItemId: `si_${it.externalId}`, role: 'origin' }];

  it('NOT-MINE: my own ask of someone else is not my item; my commitment still is', () => {
    const mine = msg({ me: true, text: '<@U0PERSONB|PERSON_B> can you send me the sizing sheet?' });
    const st = state('slack', [mine]);
    expect(proposalGate(st, { kind: 'ask', title: 'Get the sizing sheet from PERSON_B', confidence: 'sure', evidence: origin(mine) })).toMatchObject({ skip: expect.stringMatching(/my own ask/) });
    expect(proposalGate(st, { kind: 'commitment', title: 'Send PERSON_B the sizing sheet', confidence: 'sure', evidence: origin(mine) })).toEqual({ confidence: 'sure' });
  });

  it('TRI-3: an ask to a whole channel or a list lands suggested under "Ask me", is dropped under "Ignore", kept under "Treat as mine"', () => {
    const here = msg({ who: 'PERSON_K', type: 'channel', text: '<!here> can everyone add their Q4 forecast to the sheet by Friday?' });
    const list = msg({ who: 'PERSON_K', type: 'mpim', text: `<@U0A|PERSON_A> <@U0C|PERSON_C> <@${ME}|ME> can you each send numbers?` });
    const args = (it: NormalizedSourceItem) => ({ kind: 'ask', title: 'Add my Q4 forecast to the sheet', confidence: 'likely' as const, evidence: origin(it) });
    expect(proposalGate(state('slack', [here]), args(here))).toEqual({ confidence: 'guess' });
    expect(proposalGate(state('slack', [list]), args(list))).toEqual({ confidence: 'guess' });
    expect(proposalGate(state('slack', [here], { ...DEFAULT_SCANNING_PREFS, channelAsks: 'ignore' }), args(here))).toMatchObject({ skip: expect.any(String) });
    expect(proposalGate(state('slack', [here], { ...DEFAULT_SCANNING_PREFS, channelAsks: 'mine' }), args(here))).toEqual({ confidence: 'likely' });
    const direct = msg({ who: 'PERSON_K', text: 'can you add your forecast?' });
    expect(proposalGate(state('slack', [direct]), args(direct))).toEqual({ confidence: 'likely' });
  });

  it('GEM-CATCHUP / ORG-SPEED: catch-up and get-up-to-speed items only when switched on (off by default)', () => {
    const on = { ...DEFAULT_SCANNING_PREFS, meetingCatchUps: true, oppTeamCatchUps: true };
    const p = (title: string) => ({ kind: 'follow_up', title, confidence: 'likely' as const, evidence: [{ sourceItemId: 'si_x', role: 'origin' }] });
    expect(proposalGate(state('gemini_notes', []), p('Catch up: ACME deal planning (scope change)'))).toMatchObject({ skip: expect.any(String) });
    expect(proposalGate(state('calendar', []), p('Catch up on missed meeting: ACME sync'))).toMatchObject({ skip: expect.any(String) });
    expect(proposalGate(state('org62', []), p('Get up to speed on GLOBEX – Agentforce Pilot'))).toMatchObject({ skip: expect.any(String) });
    expect(proposalGate(state('gemini_notes', [], on), p('Catch up: ACME deal planning (scope change)'))).toEqual({ confidence: 'likely' });
    expect(proposalGate(state('org62', [], on), p('Get up to speed on GLOBEX – Agentforce Pilot'))).toEqual({ confidence: 'likely' });
    expect(proposalGate(state('gemini_notes', []), p('Send the ACME recap'))).toEqual({ confidence: 'likely' });
  });
});

describe('RED-1: credential redaction', () => {
  const share = 'https://share.1password.com/s#PlaceholderShareToken0123456789';
  it('masks password-manager share links and login lines in both redactors, idempotently', () => {
    for (const redact of [llmRedact, connectorRedact]) {
      const a = redact(`Demo user PLACEHOLDER: <${share}|share link>`);
      expect(a.text).not.toContain('1password');
      expect(a.kinds).toContain('password_share');
      expect(redact(a.text).text).toBe(a.text);
      expect(redact('login: admin@example.com / Placeholder123!').text).not.toContain('Placeholder123');
      expect(redact('Username: admin@example.com\nPassword: Placeholder123!').text).not.toContain('Placeholder123');
      expect(redact('u: admin@example.com\np: Placeholder123!').text).not.toContain('Placeholder123');
      for (const ok of ['Login to the org / then click Setup', 'the user / admin roles', 'see https://docs.google.com/presentation/d/FILE_X/edit']) expect(redact(ok).text, ok).toBe(ok);
    }
  });

  it('the scrub plan rewrites only rows that hold one and drops credential refs; it never returns the secret', () => {
    const rows = [
      { id: 'a', title: null, body: `creds: <${share}>`, meta: { fileRefs: [`url:${share}`] }, redaction_count: 0, redaction_kinds: null },
      { id: 'b', title: 'ok', body: 'nothing here', meta: {}, redaction_count: 0, redaction_kinds: null },
    ];
    const plan = planScrub(rows, [{ id: '1', value: `url:${share}` }, { id: '2', value: 'drive:FILE_X' }]);
    expect(plan.rows.map((r) => r.id)).toEqual(['a']);
    expect(plan.refs).toEqual(['1']);
    expect(JSON.stringify(plan.rows)).not.toContain('PlaceholderShareToken');
    expect(plan.rows[0]).toMatchObject({ count: 2, kinds: expect.arrayContaining(['password_share', 'meta']) });
  });
});

/** The same rules on either store. */
function storeSuite(name: string, make: () => Promise<{ store: ScannerStore; clock?: FakeClock; read: (id: string) => Promise<{ status: string; due: string | null; reason: string | null }> }>) {
  describe(`${name}: first-scan noise rules`, () => {
    it('DUE-1 + PAST-1: a bare date is 17:00 local; a date already past when found waits as Still needed? with a plain reason', async () => {
      const { store, read } = await make();
      const live = await propose(store, msg({ dm: 'D0DUE001' }), { title: 'Send the ACME pricing deck to PERSON_B', due: '2026-11-12' });
      expect(await read(live.workItemId)).toMatchObject({ status: 'open', due: '2026-11-13T00:00:00.000Z' });
      const old = await propose(store, msg({ dm: 'D0DUE002', at: '2026-10-19T16:00:00.000Z' }), { title: 'Review the GLOBEX sizing workbook', due: '2026-10-20' });
      const r = await read(old.workItemId);
      expect(r.status).toBe('suggested');
      expect(r.reason).toMatch(new RegExp(`^Due 2026-10-20, already past when it was found: ${STILL_NEEDED_MARK.replace('?', '\\?')}`));
      expect(isStillNeeded({ state: 'suggested', closedReason: r.reason })).toBe(true);
      // A training keeps its own rule (a fresh overdue reminder stays open).
      const t = await propose(store, msg({ dm: 'D0DUE003' }), { kind: 'training', title: 'Complete the security training', due: '2026-11-06' });
      expect((await read(t.workItemId)).status).toBe('open');
    });

    it('DUP-1: same conversation, same person, same deliverable → one item; another person or deliverable → a new one', async () => {
      const { store } = await make();
      const a = await propose(store, msg({ dm: 'D0DUP001', who: 'PERSON_B', text: 'can you send the ACME pricing deck?' }), { title: 'Send PERSON_B the ACME pricing deck' });
      const again = await propose(store, msg({ dm: 'D0DUP001', who: 'PERSON_B', text: 'any update on the pricing deck?' }), { title: 'Share the ACME pricing deck with PERSON_B' });
      expect(again.workItemId).toBe(a.workItemId);
      const other = await propose(store, msg({ dm: 'D0DUP001', who: 'PERSON_B', text: 'also can you book a room?' }), { title: 'Book a room for the ACME workshop' });
      expect(other.workItemId).not.toBe(a.workItemId);
      const elsewhere = await propose(store, msg({ dm: 'D0DUP002', who: 'PERSON_B', text: 'can you send the ACME pricing deck?' }), { title: 'Send PERSON_B the ACME pricing deck' });
      expect(elsewhere.workItemId).not.toBe(a.workItemId);
    });

    it('CMP-SUG: suggested items are checked by the completion pass too', async () => {
      const { store } = await make();
      const s = await propose(store, msg({ dm: 'D0SUG001' }), { title: 'Send the INITECH demo recording', confidence: 'guess' });
      expect(s.landedAs).toBe('suggested');
      const items = await (store as unknown as { completionItems(o: object): Promise<Array<{ workItemId: string }>> }).completionItems({ asOf: '2030-01-01T00:00:00.000Z' });
      expect(items.map((i) => i.workItemId)).toContain(s.workItemId);
    });

    it('MAP-1: the third failed relink asks "Where does this belong?" only for an ask of me; an FYI is dropped', async () => {
      const { store, clock } = await make();
      const ask = msg({ dm: 'D0MAP001', text: 'can you look at the INITECH sizing?' });
      const fyi = { ...msg({ dm: 'C0MAPCH1', type: 'channel', text: 'FYI the INITECH review moved to Friday' }), payload: { channelId: 'C0MAPCH1', channelType: 'channel', ts: '1.1' } };
      const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'catch_up', window: W });
      const [a, f] = await store.recordSourceItems(runId, [ask, fyi]);
      for (const sid of [a!.sourceItemId, f!.sourceItemId]) await store.flagUnlinked(runId, { sourceItemId: sid, reason: 'no confident home' });
      await store.reportCoverage(runId, [{ kind: 'query_window', ref: 'search:dm', from: W.from, to: W.to }]);
      await store.finishRun(runId, { cursor: { value: 'x', at: W.to }, stats: { fetched: 2, new: 2, changed: 0, linked: 0, proposed: 0, unlinked: 2, costUsd: 0 } });
      for (let i = 0; i < 2; i++) {
        const r = await store.startRun({ scope: { connector: 'slack', scope: 'reconcile:unlinked' }, trigger: 'reconcile', window: { from: NOW, to: NOW } });
        for (const sid of [a!.sourceItemId, f!.sourceItemId]) await store.flagUnlinked(r.runId, { sourceItemId: sid, reason: 'no confident home' });
        await store.finishRun(r.runId, { cursor: { value: 'relink', at: NOW }, stats: { fetched: 0, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 2, costUsd: 0 } });
      }
      const listed = await store.unlinkedSourceItems({ connector: 'slack' });
      expect(listed.find((u) => u.sourceItemId === a!.sourceItemId)).toMatchObject({ attempts: 3, toMe: true });
      const rec = new Reconciler({ store, runner: new ScriptedSkillRunner(async () => {}), clock: clock ?? new FakeClock(NOW), specs: [slackSpec({ mcpServers: () => ({}), autoRecord: undefined, triage: undefined })] });
      const rep = await rec.run({ kind: 'reconcile', id: 'r', passes: ['unlinked'], trigger: 'reconcile', priority: 20, runAt: NOW, dedupeKey: 'r' }, new AbortController().signal);
      expect(rep.triaged).toBe(1);
      expect(rep.findings.some((x) => x.sourceItemId === f!.sourceItemId && /no mapping question/.test(x.detail ?? ''))).toBe(true);
      expect((await store.unlinkedSourceItems({ connector: 'slack' })).map((u) => u.sourceItemId)).toEqual([]);
    });
  });
}

storeSuite('memory store', async () => {
  const clock = new FakeClock(NOW);
  const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), timeZone: TZ });
  return {
    store,
    clock,
    read: async (id) => {
      const w = store.listWorkItems().find((x) => x.workItemId === id) as unknown as { state: string; due?: string; statusReason?: string };
      return { status: w.state, due: w.due ?? null, reason: w.statusReason ?? null };
    },
  };
});

describe.skipIf(!pgAvailable())('db store (scratch database)', () => {
  let t: TestDb;
  let userId = '';
  beforeAll(async () => {
    t = await provisionTestDb('noise');
    const u = await t.handle.db.execute<{ id: string }>(sql`insert into users (email, display_name, timezone) values ('placeholder@example.com', 'ME Person', ${TZ}) returning id`);
    userId = u.rows[0]!.id;
  });
  afterAll(async () => t?.drop());

  storeSuite('db store', async () => {
    const clock = new FakeClock(NOW);
    const store = new DbScannerStore({ db: t.handle.db, userId, clock: () => clock.now() });
    return {
      store,
      clock,
      read: async (id) => {
        const r = await t.handle.db.execute<{ status: string; due: string | null; reason: string | null }>(sql`select status::text as status, due_at as due, status_reason as reason from work_items where id = ${id}`);
        const row = r.rows[0]!;
        return { ...row, due: row.due ? new Date(row.due).toISOString() : null };
      },
    };
  });

  it('PPL-1: a Slack author becomes a person (hidden from the directory) and every message of theirs points at it', async () => {
    const store = new DbScannerStore({ db: t.handle.db, userId, clock: () => new Date(NOW) });
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'catch_up', window: W });
    const a = msg({ dm: 'D0PPL001', who: 'PERSON_PPL' });
    const b = msg({ dm: 'D0PPL002', who: 'PERSON_PPL' });
    const mine = msg({ dm: 'D0PPL001', me: true, text: 'here you go' });
    const rows = await store.recordSourceItems(runId, [a, b, mine]);
    const r = await t.handle.db.execute<{ id: string; p: string | null }>(sql`select id, actor_person_id as p from source_items where id = any(${`{${rows.map((x) => x.sourceItemId).join(',')}}`}::uuid[])`);
    const by = new Map(r.rows.map((x) => [x.id, x.p]));
    expect(by.get(rows[0]!.sourceItemId)).toBeTruthy();
    expect(by.get(rows[1]!.sourceItemId)).toBe(by.get(rows[0]!.sourceItemId)); // one person
    const p = await t.handle.db.execute<{ n: number; slack: string | null; synthetic: boolean }>(sql`
      select count(*)::int as n,
             (select external_id from person_identities where person_id = ${by.get(rows[0]!.sourceItemId)!}::uuid and system = 'slack') as slack,
             exists (select 1 from user_settings where key = ${`cc.ext/people/${by.get(rows[0]!.sourceItemId)!}`} and value->>'synthetic' = 'true') as synthetic
        from people where owner_user_id = ${userId} and display_name = 'PERSON_PPL'`);
    expect(p.rows[0]).toMatchObject({ n: 1, slack: 'U0PERSONPPL', synthetic: true });
  });

  it('TRI-NOISE + TRI-CTX: verdicts persist on the message and a conversation reads back across runs', async () => {
    const store = new DbScannerStore({ db: t.handle.db, userId, clock: () => new Date(NOW) });
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'catch_up', window: W });
    const lines = [msg({ dm: 'D0CTX001', at: '2026-11-01T10:00:00.000Z' }), msg({ dm: 'D0CTX001', at: '2026-11-02T10:00:00.000Z', me: true, text: 'here it is' }), msg({ dm: 'D0CTX001', at: '2026-11-09T10:00:00.000Z' })];
    const rows = await store.recordSourceItems(runId, lines);
    await store.recordTriageVerdicts([{ sourceItemId: rows[0]!.sourceItemId, v: 'noise', why: 'answered' }]);
    const v = await store.triageVerdicts(rows.map((x) => x.sourceItemId));
    expect(v.get(rows[0]!.sourceItemId)).toEqual({ v: 'noise', why: 'answered' });
    expect(v.has(rows[1]!.sourceItemId)).toBe(false);
    const ctx = await store.conversationLines({ channelId: 'D0CTX001', before: { at: '2026-11-05T00:00:00.000Z', limit: 6 }, after: { at: '2026-11-05T00:00:00.000Z', limit: 4 } });
    expect(ctx.map((l) => l.sourceItemId)).toEqual(rows.map((x) => x.sourceItemId));
    expect(ctx[1]!.item.author?.isMe).toBe(true);
    expect(ctx[0]!.item.payload).not.toHaveProperty('triage');
  });

  it('SCAN-SET: the scanner reads Settings ▸ Scanning on every context (defaults when unset) and passes it to the skills', async () => {
    const store = new DbScannerStore({ db: t.handle.db, userId, clock: () => new Date(NOW) });
    expect((await store.getContext({ connector: 'slack', scope: 'inbox' }, { maxOpenItems: 0 })).scanning).toEqual(DEFAULT_SCANNING_PREFS);
    const kv = (q: ReturnType<typeof sql>) => withChangeSet({ db: t.handle.db, userId, actor: actors.system('test'), reason: 'test: scanning settings' }, (tx) => tx.execute(q));
    await kv(sql`insert into user_settings (owner_user_id, key, value) values (${userId}, 'settings.scanning', ${JSON.stringify({ version: 2, channelAsks: 'ignore', meetingCatchUps: true, oppTeamCatchUps: false, mappingQuestions: 'never' })}::jsonb)`);
    const ctx = await store.getContext({ connector: 'slack', scope: 'inbox' }, { maxOpenItems: 0 });
    expect(ctx.scanning).toEqual({ channelAsks: 'ignore', meetingCatchUps: true, oppTeamCatchUps: false, mappingQuestions: 'never' });
    const { renderRunBlock } = await import('../../../src/llm/skill-loader');
    const run = renderRunBlock({ runId: 'r', mode: 'incremental', window: W, ctx });
    expect(run).toContain('{{scan.channelAsks}} = ignore');
    expect(run).toContain('{{scan.meetingCatchUps}} = on');
    await kv(sql`delete from user_settings where owner_user_id = ${userId} and key = 'settings.scanning'`);
  });

  it('RED-1: a share link never lands in source_item_refs', async () => {
    const store = new DbScannerStore({ db: t.handle.db, userId, clock: () => new Date(NOW) });
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'catch_up', window: W });
    const it = { ...msg({ dm: 'D0RED001', text: 'creds: <https://share.1password.com/s#PlaceholderShareToken0123456789>' }), fileRefs: ['url:https://share.1password.com/s#PlaceholderShareToken0123456789', 'drive:FILE_PLACEHOLDER01'] };
    const [r] = await store.recordSourceItems(runId, [it]);
    const refs = await t.handle.db.execute<{ value: string }>(sql`select value from source_item_refs where source_item_id = ${r!.sourceItemId}`);
    expect(refs.rows.map((x) => x.value)).toEqual(['FILE_PLACEHOLDER01']); // R13: stored as the bare Drive id
    const row = await t.handle.db.execute<{ body: string; meta: unknown }>(sql`select body, meta from source_items where id = ${r!.sourceItemId}`);
    expect(JSON.stringify(row.rows[0])).not.toContain('PlaceholderShareToken');
  });
});
