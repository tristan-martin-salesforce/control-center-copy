/** Org62 SOQL replay and Google replay semantics (placeholder fixtures). */
import { describe, expect, it } from 'vitest';

import { parseEvents, parseGmailBatch, parseGmailSearch } from '../../../src/connectors/google/parse';
import { GoogleReplay } from '../../../scripts/stress/replay/google';
import { ReplayMiss } from '../../../scripts/stress/replay/slack';
import { runSoql, type SoqlTable } from '../../../scripts/stress/replay/soql';
import type { GoogleRecording } from '../../../scripts/stress/record/google';

const tables: Record<string, SoqlTable> = {
  Event: {
    object: 'Event',
    fields: ['Id', 'Subject', 'OwnerId', 'IsChild', 'SystemModstamp', 'StartDateTime', 'What.Name'],
    timeFields: ['SystemModstamp'],
    rows: [
      { Id: '00UXX0000000001', Subject: 'PLACEHOLDER demo', OwnerId: '005XX000000ME01AAA', IsChild: false, SystemModstamp: '2026-10-20T15:00:00.000+0000', StartDateTime: '2026-10-20T14:00:00.000+0000', What: { Name: 'ACME – Pilot' } },
      { Id: '00UXX0000000002', Subject: 'PLACEHOLDER sync', OwnerId: '005XX000000ME01AAA', IsChild: false, SystemModstamp: '2026-10-22T15:00:00.000+0000', StartDateTime: '2026-10-22T14:00:00.000+0000', What: null },
      { Id: '00UXX0000000003', Subject: 'child', OwnerId: '005XX000000ME01AAA', IsChild: true, SystemModstamp: '2026-10-20T16:00:00.000+0000', StartDateTime: '2026-10-20T14:00:00.000+0000', What: null },
    ],
  },
};

describe('SOQL replay', () => {
  it('evaluates the skill-shaped windowed query against the simulated now', () => {
    const q = "SELECT Id, Subject, What.Name, SystemModstamp FROM Event WHERE OwnerId = '005XX000000ME01AAA' AND IsChild = false AND SystemModstamp >= 2026-10-01T00:00:00Z AND SystemModstamp < 2026-11-01T00:00:00Z ORDER BY SystemModstamp, Id LIMIT 200";
    const early = runSoql(tables, q, new Date('2026-10-21T00:00:00Z'));
    expect(early.records.map((r) => r.Id)).toEqual(['00UXX0000000001']); // the later row is not visible yet
    expect(early.records[0]).toMatchObject({ attributes: { type: 'Event' }, What: { Name: 'ACME – Pilot' } });
    const later = runSoql(tables, q, new Date('2026-10-23T00:00:00Z'));
    expect(later.records.map((r) => r.Id)).toEqual(['00UXX0000000001', '00UXX0000000002']);
    expect(later.records[1]!.What).toBeNull();
  });

  it('supports OR/parentheses, IN, LIKE, LAST_N_DAYS and LIMIT; unknown fields/objects are misses', () => {
    const now = new Date('2026-10-23T00:00:00Z');
    expect(runSoql(tables, "SELECT Id FROM Event WHERE (Subject LIKE '%demo%' OR Subject = 'PLACEHOLDER sync') AND Id IN ('00UXX0000000001','00UXX0000000002') AND StartDateTime = LAST_N_DAYS:30 LIMIT 1", now).records).toHaveLength(1);
    expect(() => runSoql(tables, 'SELECT Id, Description FROM Event', now)).toThrow(ReplayMiss);
    expect(() => runSoql(tables, 'SELECT Id FROM Opportunity', now)).toThrow(ReplayMiss);
    expect(() => runSoql(tables, 'SELECT COUNT() FROM Event', now)).toThrow(ReplayMiss);
  });
});

const T = (s: string) => Date.parse(s);
const rec: GoogleRecording = {
  span: { from: '2026-10-20T00:00:00.000Z', to: '2026-10-23T00:00:00.000Z' },
  gmail: {
    bases: { 'in:sent': { from: T('2026-10-20T00:00:00Z'), to: T('2026-10-23T00:00:00Z') } },
    messages: {
      a1: { id: 'a1', threadId: 't1', bases: ['in:sent'], dateMs: T('2026-10-20T15:00:00Z'), block: 'Message ID: a1\nSubject: PLACEHOLDER deck\nFrom: ME <me@example.com>\nTo: A <a@example.com>\nDate: Tue, 20 Oct 2026 15:00:00 +0000\n\n--- BODY ---\nattached\n' },
      a2: { id: 'a2', threadId: 't2', bases: ['in:sent'], dateMs: T('2026-10-22T15:00:00Z'), block: 'Message ID: a2\nSubject: later\nFrom: ME <me@example.com>\nTo: B <b@example.com>\nDate: Thu, 22 Oct 2026 15:00:00 +0000\n\n--- BODY ---\nlater\n' },
    },
    threads: {},
  },
  calendar: {
    from: '2026-10-19T00:00:00.000Z',
    to: '2026-11-10T00:00:00.000Z',
    header: 'Events:',
    blocks: ['- "PLACEHOLDER sync" (Starts: 2026-10-21T15:00:00Z, Ends: 2026-10-21T15:30:00Z)\n  ID: ev1 | Link: https://cal.example.com/ev1\n  Attachments: Notes by Gemini\n    File ID: docLater\n    MIME Type: application/vnd.google-apps.document'],
  },
  drive: { feedFrom: '2026-10-01T00:00:00.000Z', rows: ['- Name: "Notes by Gemini" (ID: docLater, Type: application/vnd.google-apps.document, Created: 2026-10-21T16:00:00Z, Modified: 2026-10-21T16:00:00Z, Last Edited By: ME <me@example.com>)'], content: { docLater: { tool: 'get_doc_as_markdown', text: '# Notes' } } },
};

describe('Google replay', () => {
  it('Gmail search filters by window and simulated now; content only for visible mail', async () => {
    let now = T('2026-10-21T00:00:00Z');
    const g = new GoogleReplay(rec, { now: () => now });
    const q = { query: `in:sent after:${T('2026-10-20T00:00:00Z') / 1000} before:${T('2026-10-23T00:00:00Z') / 1000}`, page_size: 10 };
    expect(parseGmailSearch(await g.call('search_gmail_messages', q)).hits.map((h) => h.id)).toEqual(['a1']);
    now = T('2026-10-22T16:00:00Z');
    expect(parseGmailSearch(await g.call('search_gmail_messages', q)).hits.map((h) => h.id)).toEqual(['a2', 'a1']);
    expect(parseGmailBatch(await g.call('get_gmail_messages_content_batch', { message_ids: ['a1'] }))[0]!.subject).toBe('PLACEHOLDER deck');
    await expect(g.call('search_gmail_messages', { query: 'in:inbox after:1 before:2' })).rejects.toThrow(ReplayMiss);
    expect(g.stats.leaks).toBe(0);
  });

  it('Calendar hides attachments whose Drive file did not exist yet; Drive content waits for creation', async () => {
    let now = T('2026-10-21T15:40:00Z');
    const g = new GoogleReplay(rec, { now: () => now });
    const args = { time_min: '2026-10-21T00:00:00Z', time_max: '2026-10-22T00:00:00Z' };
    expect(parseEvents(await g.call('get_events', args))[0]!.attachments).toEqual([]);
    await expect(g.call('get_doc_as_markdown', { document_id: 'docLater' })).rejects.toThrow(/not found/i);
    now = T('2026-10-21T17:00:00Z');
    expect(parseEvents(await g.call('get_events', args))[0]!.attachments[0]!.fileId).toBe('docLater');
    expect(await g.call('get_doc_as_markdown', { document_id: 'docLater' })).toBe('# Notes');
  });
});
