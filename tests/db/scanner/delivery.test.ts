/**
 * DLV-1 (placeholders only): my reply in the ask's own DM, after it, carrying the asked-for file or link, is a Sure
 * completion; "here you go" alone stays Likely, and so does an unrelated attachment. REC-1 records attachments.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { slackFilesOf } from '../../../src/connectors/slack/parse';
import { createRunState } from '../../../src/llm/cc-tools';
import { SlackAutoRecorder } from '../../../src/llm/slack-rec';
import { deliveryMatch } from '../../../src/scanner/delivery';
import { DbScannerStore } from '../../../src/scanner/store-db';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import type { NormalizedSourceItem, ScannerStore } from '../../../src/scanner/types';
import { PROFILE } from '../../scanner/runtime/helpers/world';
import { pgAvailable, provisionTestDb, type TestDb } from './helpers/pg';

// The db-store cases propose and link on a real database; under the full suite's load 5 s is too short.

const ME = 'U0PLACEME';
const DM = 'D0PLACEHOLD';
const W = { from: '2026-11-06T15:00:00.000Z', to: '2026-11-06T17:00:00.000Z' };

describe('deliveryMatch', () => {
  it('a file or link of the kind the title asks for, or one sharing a title word', () => {
    expect(deliveryMatch({ title: 'Send PERSON_B the repo folder in chat' }, { files: [{ name: 'Placeholder_Estimator.zip', mimetype: 'application/zip' }] })).toMatch(/file/);
    expect(deliveryMatch({ title: 'Share the ACME pricing deck' }, { urls: ['https://docs.google.com/presentation/d/FILE_PLACEHOLDER/edit'] })).toMatch(/link \(slides\)/);
    expect(deliveryMatch({ title: 'Send the estimator to PERSON_B' }, { files: [{ name: 'Estimator_v2.xlsx' }] })).toMatch(/file/); // a shared title word
    expect(deliveryMatch({ title: 'Send PERSON_B the repo folder' }, { hasFile: true })).toBe('a file');
  });
  it('no attachment, or an unrelated one, is not a delivery', () => {
    expect(deliveryMatch({ title: 'Send PERSON_B the repo folder' }, {})).toBeNull();
    expect(deliveryMatch({ title: 'Share the ACME pricing deck' }, { files: [{ name: 'team_photo.png', mimetype: 'image/png' }] })).toBeNull();
    expect(deliveryMatch({ title: 'Answer PERSON_C on how tables persist' }, { hasFile: true })).toBeNull(); // nothing to deliver
  });
});

describe('REC-1 records attachments', () => {
  it('parses the Files line of a detailed read and marks has:file search hits; a later sighting adds them', async () => {
    expect(slackFilesOf(['Reactions: thanks (1)', 'Files: Placeholder.zip (ID: F0PLACE1, application\\/zip, 75.8 MB)'])).toEqual([{ name: 'Placeholder.zip', id: 'F0PLACE1', mimetype: 'application/zip', size: '75.8 MB' }]);
    const store = new InMemoryScannerStore({ profile: { ...structuredClone(PROFILE), me: { ...PROFILE.me, slackId: ME } } as never });
    const ctx = await store.getContext({ connector: 'slack', scope: 'inbox' });
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'catch_up', window: W });
    const state = createRunState({ runId, connector: 'slack', window: W, context: ctx });
    const rec = new SlackAutoRecorder(store, state, ctx);
    const hit = (q: string) => ({ results: `# Search Results\n\n## Messages (1 results)\n### Result 1 of 1\nChannel: DM (ID: ${DM})\nParticipants: Me (ID: ${ME}), PERSON_B (ID: U0PLACEB)\nFrom: Me <me@example.com> (ID: ${ME}) \nTime: 2026-11-06 09:45:42 MST\nMessage_ts: 1793979942.009289\nPermalink: [link](https://example.slack.com/archives/${DM}/p1793979942009289)\nText: \nYep here you go!\n\n---\n\n`, q });
    await rec.onToolResult('mcp__slack__slack_search_public_and_private', { query: `from:<@${ME}> after:2026-11-05` }, hit('s3'), 'tu1');
    const key = `slack:${DM}:1793979942.009289`;
    expect((state.items.get(key)?.payload as { hasFile?: boolean } | undefined)?.hasFile).toBeUndefined();
    await rec.onToolResult('mcp__slack__slack_search_public_and_private', { query: `from:<@${ME}> has:file after:2026-11-05` }, hit('s4'), 'tu2');
    expect((state.items.get(key)?.payload as { hasFile?: boolean }).hasFile).toBe(true);
    const read = { messages: `Channel: DM (${DM})\n\n=== Message from Me <me@example.com> (${ME}) at 2026-11-06 09:45:42 MST === \nMessage TS: 1793979942.009289\nYep here you go!\nReactions: thanks (1)\nFiles: Placeholder.zip (ID: F0PLACE1, application\\/zip, 75.8 MB)` };
    await rec.onToolResult('mcp__slack__slack_read_channel', { channel_id: DM }, read, 'tu3');
    expect((state.items.get(key)?.payload as { files?: { name: string }[] }).files?.[0]?.name).toBe('Placeholder.zip');
  });
});

/** The ask from PERSON_B in my DM, and my reply 16 minutes later. */
const ask = (n: number): NormalizedSourceItem => ({ connector: 'slack', kind: 'message', externalId: `${DM}:179397900${n}.000100`, dedupeKey: `slack:${DM}:179397900${n}.000100`, contentHash: `a${n}`, occurredAt: '2026-11-06T16:30:00.000Z', title: '', excerpt: 'could you send the repo folder here in the chat?', author: { name: 'PERSON_B', externalId: 'U0PLACEB', isMe: false }, threadRef: `slack:${DM}:179397900${n}.000100`, payload: { channelId: DM, channelType: 'im', ts: `179397900${n}.000100` } });
const reply = (n: number, payload: Record<string, unknown> = {}, text = 'Yep here you go!'): NormalizedSourceItem => ({ connector: 'slack', kind: 'message', externalId: `${DM}:179397994${n}.000100`, dedupeKey: `slack:${DM}:179397994${n}.000100`, contentHash: `r${n}`, occurredAt: '2026-11-06T16:46:00.000Z', title: '', excerpt: text, author: { name: 'Me', externalId: ME, isMe: true }, threadRef: `slack:${DM}:179397994${n}.000100`, payload: { channelId: DM, channelType: 'im', ts: `179397994${n}.000100`, ...payload } });

let asks = 0;
/** The same message in another DM (each db-store scenario gets its own DM: DUP-1 makes one DM's repeat ask one item). */
const inDm = (it: NormalizedSourceItem, dm: string): NormalizedSourceItem => {
  const swap = (v: string) => v.replace(DM, dm);
  return { ...it, externalId: swap(it.externalId), dedupeKey: swap(it.dedupeKey), threadRef: it.threadRef ? swap(it.threadRef) : it.threadRef, payload: { ...it.payload, channelId: dm } };
};
async function scenario(store: ScannerStore, title: string, r: NormalizedSourceItem, dm = DM): Promise<string> {
  const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'catch_up', window: W });
  const [a, b] = await store.recordSourceItems(runId, [inDm(ask(++asks), dm), inDm(r, dm)]);
  const { workItemId } = await store.proposeItem(runId, { kind: 'ask', title, evidence: [{ sourceItemId: a!.sourceItemId, role: 'origin', reason: 'asked in a DM' }], confidence: 'sure' });
  await store.linkEvidence(runId, { workItemId, sourceItemId: b!.sourceItemId, role: 'completion', confidence: 'likely', reason: 'triage: my reply' });
  return workItemId;
}

describe('delivery makes a completion Sure (memory store)', () => {
  const conf = async (title: string, r: NormalizedSourceItem) => {
    const store = new InMemoryScannerStore({ profile: structuredClone(PROFILE) });
    const id = await scenario(store, title, r);
    return store.evidenceFor(id).find((e) => e.role === 'completion')!;
  };
  it('reply + the asked-for file → sure', async () => expect(await conf('Send PERSON_B the repo folder in chat', reply(1, { files: [{ name: 'Placeholder.zip', mimetype: 'application/zip' }] }))).toMatchObject({ confidence: 'sure', reason: expect.stringMatching(/^delivered_with_attachment:/) }));
  it('reply alone → stays likely', async () => expect((await conf('Send PERSON_B the repo folder in chat', reply(2))).confidence).toBe('likely'));
  it('reply + an unrelated attachment → stays likely', async () => expect((await conf('Share the ACME pricing deck', reply(3, { files: [{ name: 'team_photo.png', mimetype: 'image/png' }] }))).confidence).toBe('likely'));
});

describe.skipIf(!pgAvailable())('delivery makes a completion Sure (db store)', () => {
  let t: TestDb;
  let store: DbScannerStore;
  beforeAll(async () => {
    t = await provisionTestDb('delivery');
    const u = await t.handle.db.execute<{ id: string }>(sql`insert into users (email, display_name, timezone) values ('placeholder@example.com', 'Placeholder', 'UTC') returning id`);
    store = new DbScannerStore({ db: t.handle.db, userId: u.rows[0]!.id });
  });
  afterAll(async () => t?.drop());
  let dms = 0;
  const conf = async (title: string, r: NormalizedSourceItem) => {
    const id = await scenario(store, title, r, `${DM}${++dms}`);
    const row = await t.handle.db.execute<{ c: number; r: string }>(sql`select confidence::float8 as c, rationale as r from work_item_evidence where work_item_id = ${id} and role = 'completion'`);
    return row.rows[0]!;
  };
  it('reply + the asked-for file → sure', async () => {
    const r = await conf('Send PERSON_B the repo folder in chat', reply(4, { files: [{ name: 'Placeholder.zip', mimetype: 'application/zip' }] }));
    expect(r.c).toBeGreaterThanOrEqual(0.9);
    expect(r.r).toMatch(/^delivered_with_attachment: file Placeholder\.zip/);
  });
  it('reply alone → stays likely; an unrelated attachment too', async () => {
    expect((await conf('Send PERSON_B the repo folder in chat', reply(5))).c).toBeLessThan(0.9);
    expect((await conf('Share the ACME pricing deck', reply(6, { files: [{ name: 'team_photo.png', mimetype: 'image/png' }] }))).c).toBeLessThan(0.9);
  });
});
