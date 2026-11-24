/**
 * SE golden (lane B, D-55): what the app did for an SE before the scanners, logging and gates followed the persona,
 * captured from the code before the change. The SE persona must reproduce it exactly: the Org62 scopes and their
 * cadence, every source, the Log & fix rows on the placeholder seed, and the Slackbot work order byte for byte
 * (D-66 changed its Description cells on purpose: a teammate's note, then the CC# key, last; D-103 (c) added the
 * sentence that a WhatId may be an Account (001…) or an Opportunity (006…)).
 */
import { describe, expect, it } from 'vitest';

import { renderWorkOrder, eventRow } from '@/engines/activity/slackbot';
import { SCAN_CONNECTORS } from '@/jobs';
import { personaOf } from '@/personas';
import { DEFAULT_SCOPE_MULTIPLIER } from '@/scanner/runtime/cadence';
import { org62Spec, slackSpec } from '@/scanner/runtime/connectors';
import type { ScanContext } from '@/scanner/types';
import { createMockDataSource } from '@/server/datasource/mock';

const GOLDEN = {
  scopes: ['opps', 'events', 'dcs', 'book', 'missed_opps'],
  multipliers: [1, 2, 2, 1, 48],
  connectors: ['slack', 'org62', 'gmail', 'calendar', 'drive', 'gemini_notes', 'claude_sessions', 'trainings', 'watch', 'vdp'],
  // The Org62 row folds into the quarter row while that one is drawn (both listed the same handed-off rows), which
  // leaves the fifth slot of the wide cap to the VDP row.
  gapIds: ['gap:connector:vdp', 'gap:quarter_log', 'gap:missed_dc', 'gap:needs_input', 'gap:vdp_open'],
  // WO-1 (2026-11-23): one table per object and verb, each with its paragraph; the cells are the same values
  workOrder: "::: {.callout}\n**Slackbot: this canvas is a complete work order. Execute it in Org62 for PERSON_ME (User Id 005XX0000000OWNAAA) without asking for more context.** Rules:\n:::\n\n1. **One table per job.** Each table below does one thing to one kind of Org62 record (its heading says which: create or update, and the object). Work through the tables from top to bottom, and follow the paragraph under each heading. Every column is named by its Org62 field (API name).\n2. Work through everything in batches of 25. Don't stop on an individual failure. At the end, reply with counts: created / updated / skipped as duplicate / failed (with the error for each failure).\n\n_Generated 2026-11-10 20:00 UTC by Command Center · batch Nov 2–8. Command Center checks Org62 afterwards and flags any row that didn't land._\n\n## EVENTS TO CREATE (2 rows · 3.00 h of activities)\n\n**EVENTS TO CREATE:** Create one Event per row with RecordTypeId `012XX0000000RTYAAA` (Solutions Event) and OwnerId `005XX0000000OWNAAA`. Each column is the Event field of the same name: Subject, StartDateTime and EndDateTime (UTC, exactly as given), SE_Task_Type__c, Duration__c, WhatId, Meeting_Type__c (only when given) and Description (exactly as given, its CC# key included). A WhatId is an Opportunity (006…) or an Account (001…): set it as given either way. Do not set DurationInMinutes or Remote__c. Skip a row ONLY if PERSON_ME already owns an Event with RecordTypeId `012XX0000000RTYAAA` (Solutions Event) and the same Subject and StartDateTime. \"Sales Events\" records (Type = AE meeting, IsChild = true) are copies of AE calendar invites, not SE time, so they are NOT duplicates: create the row anyway.\n\n|#|Subject|StartDateTime (UTC)|EndDateTime (UTC)|SE_Task_Type__c|Duration__c|WhatId|Meeting_Type__c|Description|\n|---|---|---|---|---|---|---|---|---|\n|1|ACCOUNT_1 / Discovery|2026-11-04T23:00:00.000Z|2026-11-05T00:00:00.000Z|Customer Discovery|1|006XX0000000OPPAAA||Discovery session: ACCOUNT_1. · CC#act-1|\n|2|ACCOUNT_1 / Discovery|2026-11-04T23:00:00.000Z|2026-11-05T01:00:00.000Z|Workshop|2|006XX0000000OPPAAA|Data Cloud Workshop|Workshop: ACCOUNT_1 – Discovery. · CC#act-2|\n\n## EVENTS TO UPDATE (1 row)\n\n**EVENTS TO UPDATE:** each row changes one field on an existing Event: on the record whose Id is in Record Id, set the field named in Field to New value, nothing else. Current value (what Org62 held when this was written) and Why are for you to read: never write them anywhere.\n\n|#|Record Id|Field|New value|Current value|Why|\n|---|---|---|---|---|---|\n|1|00UXX0000000EVTAAA|Duration__c|1.5|(blank)|Time never filled|",
};

const ctx = (persona?: ScanContext['persona']): ScanContext => ({ scope: { connector: 'org62', scope: 'opps' }, cursor: null, gaps: [], me: { userId: 'u', name: 'PERSON_ME' }, watchList: [], aliases: { accounts: [], channels: [] }, openItems: [], initiatives: [], skillVersion: '', ...(persona ? { persona } : {}) });

const row = (over: Partial<Parameters<typeof eventRow>[0]> = {}) =>
  eventRow({ id: 'act-1', subject: 'ACCOUNT_1 | Discovery', start: '2026-11-04T16:00:00-07:00', end: '2026-11-04T17:00:00-07:00', durationH: 1, taskType: 'Customer Discovery', whatOrg62Id: '006XX0000000OPPAAA', origin: 'calendar', ...over });

describe('SE golden: unchanged by personas', () => {
  it('Org62 scopes and their cadence (no persona in the context, and the SE persona)', () => {
    for (const c of [ctx(), ctx(personaOf({ profile: { role: 'se_ic' } }))]) {
      const scopes = org62Spec().scopes(c);
      expect(scopes).toEqual(GOLDEN.scopes);
      expect(scopes.map((s) => DEFAULT_SCOPE_MULTIPLIER('org62', s))).toEqual(GOLDEN.multipliers);
    }
    expect(slackSpec().scopes(ctx())).toEqual(['inbox']);
  });

  it('every source', () => {
    expect([...SCAN_CONNECTORS]).toEqual(GOLDEN.connectors);
    expect(personaOf({}).connectors).toEqual(GOLDEN.connectors);
  });

  it('the Log & fix rows on the placeholder seed', async () => {
    const h = await createMockDataSource().getHome({ query: { wide: true } });
    const ids = h.sections.flatMap((s) => s.rows).filter((r) => r.id.startsWith('gap:')).map((r) => r.id);
    expect(ids).toEqual(GOLDEN.gapIds);
  });

  it('the Slackbot work order, byte for byte', () => {
    const md = renderWorkOrder({
      ownerName: 'PERSON_ME',
      ownerOrg62Id: '005XX0000000OWNAAA',
      recordTypeId: '012XX0000000RTYAAA',
      generatedAt: '2026-11-10T20:00:00.000Z',
      events: [row(), row({ id: 'act-2', taskType: 'Workshop', durationH: 2 })],
      updates: [{ recordId: '00UXX0000000EVTAAA', field: 'Duration__c', newValue: '1.5', currentValue: '(blank)', why: 'Time never filled' }],
      sourceLabel: 'Command Center · batch Nov 2–8',
    });
    expect(md).toBe(GOLDEN.workOrder);
  });
});
