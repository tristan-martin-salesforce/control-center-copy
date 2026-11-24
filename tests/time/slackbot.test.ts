/**
 * The Slackbot work order (src/engines/activity/slackbot.ts): the format Slackbot executes in Org62. Pins the rules
 * the autopilot's working canvas relied on: UTC instants with .000Z, Meeting_Type__c only for Workshop / POC, the
 * Description (D-66: the row's note, then the CC# key, last), end = start + logged hours, safe cells, and part splits
 * that repeat the table header.
 * Placeholder ids only.
 */
import { describe, expect, it } from 'vitest';

import { parseWorkOrder } from '@/engines/activity/canvas-parse';
import { cell, eventRow, meetingTypeFor, quarterHours, renderWorkOrder, sfInstant, splitWorkOrder, type WorkOrderInput } from '@/engines/activity/slackbot';

const OWNER = '005XX0000000OWNAAA';
const RT = '012XX0000000RTYAAA';

const row = (over: Partial<Parameters<typeof eventRow>[0]> = {}) =>
  eventRow({ id: 'act-1', subject: 'ACCOUNT_1 | Discovery', start: '2026-11-04T16:00:00-07:00', end: '2026-11-04T17:00:00-07:00', durationH: 1, taskType: 'Customer Discovery', whatOrg62Id: '006XX0000000OPPAAA', origin: 'calendar', ...over });

const input = (events = [row()], updates: WorkOrderInput['updates'] = []): WorkOrderInput => ({ ownerName: 'PERSON_ME', ownerOrg62Id: OWNER, recordTypeId: RT, generatedAt: '2026-11-10T20:00:00.000Z', events, updates, sourceLabel: 'Command Center · batch Nov 2–8' });

describe('event rows', () => {
  it('uses Org62 UTC instants and quarter hours; keeps the exact end unless the hours were changed (D-40)', () => {
    const r = row({ durationH: 1.1 });
    expect(r.startUtc).toBe('2026-11-04T23:00:00.000Z');
    expect(r.durationH).toBe(1);
    expect(r.endUtc).toBe('2026-11-05T00:00:00.000Z'); // the meeting's own end
    const edited = row({ durationH: 2.5 });
    expect(edited.endUtc).toBe('2026-11-05T01:30:00.000Z'); // hours changed: end = start + hours
    expect(sfInstant('2026-11-04T23:00:00.123Z')).toBe('2026-11-04T23:00:00.000Z');
    expect(quarterHours(0.1)).toBe(0);
    expect(quarterHours(0.13)).toBe(0.25);
  });

  it('sets Meeting_Type__c only for workshops and proofs of concept', () => {
    expect(meetingTypeFor('Workshop')).toBe('Data Cloud Workshop');
    expect(meetingTypeFor('POC')).toBe('Proof of Concept');
    expect(meetingTypeFor('Customer Discovery')).toBe('');
    expect(meetingTypeFor(null)).toBe('');
  });

  it("D-66: Description is the row's note, then the CC# key at the end", () => {
    const note = 'Discovery session with the ACCOUNT_1 data team on their profile sources. Next step: Send the POC plan.';
    expect(row({ note }).description).toBe(`${note} · CC#act-1`);
    // no note stored (a row from before D-66, a manual row): one is made from the row's own fields
    expect(row({ customer: 'ACCOUNT_1', externalDomains: ['account1.example'] }).description).toBe('Discovery session with the ACCOUNT_1 team. · CC#act-1');
    // you emptied the note: the key alone
    expect(row({ note: '' }).description).toBe('CC#act-1');
    // the old log key is gone: no origin, no date, no "evidence:" dump
    expect(row({ note }).description).not.toMatch(/\| calendar|evidence:|CF: external/);
  });

  it('D-66: a note is cleaned on the way out (credentials, contact details, pipes) and never breaks the key', () => {
    const r = row({ note: 'Met the team | shared creds xoxb-123456789012-abcdefghijkl, mail ops@account1.example' });
    expect(r.description).not.toContain('xoxb-');
    expect(r.description).not.toContain('@account1.example');
    expect(r.description).not.toContain('|');
    expect(r.description).toMatch(/ · CC#act-1$/);
  });

  it('D-66: the exact CC#<uuid> token ends the Description cell, whole, after the note', () => {
    const id = 'a1b2c3d4-0000-4000-8000-000000000001';
    const md = renderWorkOrder(input([row({ id, note: 'Workshop with the ACCOUNT_1 team on the data model.' })]));
    const parsed = parseWorkOrder(md);
    expect(parsed.adds).toHaveLength(1);
    expect(parsed.adds[0]).toMatchObject({ kind: 'event', subject: 'ACCOUNT_1 / Discovery', startsAt: '2026-11-04T23:00:00.000Z', description: `Workshop with the ACCOUNT_1 team on the data model. · CC#${id}` });
    expect(md.split('\n').find((l) => l.startsWith('|1|ACCOUNT_1 / Discovery|'))).toMatch(new RegExp(` · CC#${id}\\|$`));
  });

  it('cells never break the table', () => {
    expect(cell('a | b\nc')).toBe('a / b ⏎ c');
    expect(cell(null)).toBe('');
  });
});

describe('work order', () => {
  it('renders the rules with the owner and record type, then one table per object and verb (WO-1)', () => {
    const md = renderWorkOrder(input([row(), row({ id: 'act-2', taskType: 'Workshop', durationH: 2 })], [{ recordId: '00UXX0000000EVTAAA', field: 'Duration__c', newValue: '1.5', currentValue: '(blank)', why: 'Time never filled' }]));
    expect(md).toContain(`Execute it in Org62 for PERSON_ME (User Id ${OWNER}) without asking for more context.`);
    expect(md).toContain(`RecordTypeId \`${RT}\` (Solutions Event) and OwnerId \`${OWNER}\``);
    expect(md).toContain('## EVENTS TO CREATE (2 rows · 3.00 h of activities)');
    expect(md).toContain('|1|ACCOUNT_1 / Discovery|2026-11-04T23:00:00.000Z|2026-11-05T00:00:00.000Z|Customer Discovery|1|006XX0000000OPPAAA||Discovery session: ACCOUNT_1. · CC#act-1|');
    expect(md).toContain('|2|ACCOUNT_1 / Discovery|2026-11-04T23:00:00.000Z|2026-11-05T01:00:00.000Z|Workshop|2|006XX0000000OPPAAA|Data Cloud Workshop|');
    expect(md).toContain('## EVENTS TO UPDATE (1 row)');
    expect(md).toContain('|#|Subject|StartDateTime (UTC)|EndDateTime (UTC)|SE_Task_Type__c|Duration__c|WhatId|Meeting_Type__c|Description|');
    expect(md).toContain('|#|Record Id|Field|New value|Current value|Why|');
    expect(md).not.toContain('|Object|');
    // a table only when it has rows: no DC or use-case tables here
    expect(md).not.toMatch(/^## (DEAL CONTRIBUTIONS|USE CASES)/m);
    expect(md).toContain('|1|00UXX0000000EVTAAA|Duration__c|1.5|(blank)|Time never filled|');
    expect(md).not.toMatch(/Tristan/);
  });

  it('splits at row boundaries and repeats the title and header in the next part', () => {
    const events = Array.from({ length: 80 }, (_, n) => row({ id: `act-${n}`, subject: `ACCOUNT_${n} | ${'meeting '.repeat(8)}` }));
    const md = renderWorkOrder(input(events));
    const parts = splitWorkOrder(md, 6000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(6400);
    expect(parts[1]).toMatch(/^## EVENTS TO CREATE \(80 rows .*\(continued\)\n\n\|#\|Subject\|/);
    const rows = parts.join('\n').split('\n').filter((l) => /^\|\d+\|ACCOUNT_/.test(l));
    expect(rows).toHaveLength(80);
  });
});
