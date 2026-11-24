/**
 * Golden days (lane 07 R9, §4.5): the synthetic sample database (`sample-data/tables`, placeholder people and
 * accounts) turned into the contract records the db DataSource reads, then into the engine's inputs through the
 * SAME prod functions `db/rank.ts` `priorityInputs` composes: `priorityItemsFrom` + `meetingsFrom` (the shared pure
 * builder, src/engines/priority/inputs.ts), `capacityInputs` (db/capacity.ts) and `utcOffsetMinutes`. Only the row →
 * record step is test code (it mirrors `db/store/work.ts` / `entities.ts` for the fields the builder reads).
 *
 * The policy is the persona's role template (`SE_IC_POLICY`), what an SE starts with; the sample user's own v3 rows
 * live in `priority_policies` and need the store to map, which these evals deliberately avoid.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { CalendarEvent, Evidence, Person, WorkItemRecord, WorkKind, WorkState } from '@/contract';
import { SE_IC_POLICY } from '@/engines/priority/policy';
import { meetingsFrom, priorityItemsFrom } from '@/engines/priority/inputs';
import type { PriorityInputs } from '@/engines/priority/types';
import { personaOf } from '@/personas';
import { capacityInputs, type CapacitySource } from '@/server/datasource/db/capacity';
import { utcOffsetMinutes } from '@/server/datasource/db/rank';

const TABLES = path.resolve(__dirname, '../../../sample-data/tables');

type Row = Record<string, unknown>;
const cache = new Map<string, Row[]>();
function table(name: string): Row[] {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(path.join(TABLES, `${name}.json`), 'utf8')) as Row[]);
  return cache.get(name)!;
}

/** The sample generator's deterministic ids (sample-data/lib/kit.ts `uid`), so fixtures can name `wi-060`. */
export function uid(tableName: string, key: string | number): string {
  const h = createHash('sha1').update(`cc-sample|${tableName}|${key}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export interface GoldenDay {
  name: string;
  description: string;
  /** The instant (UTC ISO). */
  now: string;
  timezone: string;
  workingHours: { start: string; end: string; days: number[] };
  /**
   * What happened between the sample's snapshot (Wed 11-18 09:00 MT) and `now`: per work-item key, the new state. A
   * day before the snapshot needs none for what came later: items created after `now` don't exist, and items closed
   * after it are open.
   */
  overrides?: Record<string, { state?: WorkState; due?: string | null; dueKind?: 'hard' | 'soft' | 'inferred' }>;
  /** Meetings the day adds to the sample calendar (accepted, busy): an afternoon that fills up. */
  extraMeetings?: Array<{ title: string; start: string; end: string; external?: boolean }>;
  /** How many ranked items the first screen shows (Do now + the rows under it). */
  firstScreen: number;
  /** The ideal Top 3, slot by slot; each slot accepts any of its keys. agreement@3 = slots met / 3. */
  goldenTop3: string[][];
  expectations: Expectation[];
}

export type Expectation =
  | { kind: 'inTop3'; anyOf: string[]; note?: string; knownGap?: string }
  | { kind: 'notFirstScreen'; ids: string[]; note?: string; knownGap?: string }
  | { kind: 'order'; above: string; below: string; note?: string; knownGap?: string }
  | { kind: 'capacity'; is: 'overbooked' | 'fits'; note?: string; knownGap?: string }
  | { kind: 'whyContains'; id: string; phrases: string[]; note?: string; knownGap?: string }
  /** priority@2: the admin batch is promoted to today with these items (priority@1.1 has no batch: it fails these). */
  | { kind: 'adminBatch'; promoted: string[]; note?: string; knownGap?: string }
  /** priority@2: the Make room list starts with one of `first` and never proposes `never`. */
  | { kind: 'makeRoom'; first: string[]; never: string[]; note?: string; knownGap?: string };

const iso = (v: unknown): string | null => (typeof v === 'string' ? new Date(v).toISOString() : null);

/** The contract records the read model would hold for the sample user (fields the priority inputs read). */
export function sampleModel(day: GoldenDay) {
  const me = table('users')[0]!;
  const managerId = me.manager_person_id as string | null;
  const personRows = new Map(table('people').map((p) => [p.id as string, p]));
  const people = new Map<string, Person>();
  for (const p of personRows.values()) {
    if (p.is_me) continue;
    const ext = p.affiliation === 'customer' || p.affiliation === 'partner';
    people.set(p.id as string, {
      id: p.id as string,
      name: p.display_name as string,
      ...(managerId === p.id ? { isManager: true } : {}),
      ...(ext ? { isExternal: true } : {}),
      accountId: (p.account_id as string | null) ?? null,
      ...(p.title ? { title: p.title as string } : {}),
      ...(p.tier !== 'normal' ? { tier: p.tier as Person['tier'] } : {}),
    });
  }
  const ref = (id: unknown) => {
    const p = typeof id === 'string' ? people.get(id) : undefined;
    return p ? { id: p.id, name: p.name, ...(p.isManager ? { isManager: true } : {}), ...(p.isExternal ? { isExternal: true } : {}) } : null;
  };

  const sources = new Map(table('source_items').map((s) => [s.id as string, s]));
  const evidence: Evidence[] = table('work_item_evidence').map((e) => {
    const si = e.source_item_id ? sources.get(e.source_item_id as string) : undefined;
    const author = si?.actor_person_id ? (personRows.get(si.actor_person_id as string)?.display_name as string | undefined) : undefined;
    return {
      id: e.id as string,
      workItemId: e.work_item_id as string,
      role: e.role as Evidence['role'],
      source: { kind: 'slack', label: 'source', ...(si?.occurred_at ? { at: iso(si.occurred_at)! } : {}) },
      at: iso(e.created_at)!,
      summary: '',
      snippet: null,
      author: author ?? null,
      isNew: false,
      confidence: null,
    } as Evidence;
  });
  const originKind = new Map<string, string>();
  for (const e of table('work_item_evidence')) {
    if (e.role !== 'origin' || originKind.has(e.work_item_id as string)) continue;
    const si = e.source_item_id ? sources.get(e.source_item_id as string) : undefined;
    if (si) originKind.set(e.work_item_id as string, si.source === 'gemini_notes' ? 'gemini' : (si.source as string));
  }

  const links = table('work_item_links');
  const training = new Map(table('work_item_training_details').map((t) => [t.work_item_id as string, t]));
  const byKey = new Map<string, string>();
  for (let n = 1; n <= 200; n++) {
    const k = `wi-${String(n).padStart(3, '0')}`;
    byKey.set(uid('work_items', k), k);
  }
  const overrides = day.overrides ?? {};
  // a day before the snapshot sees the database as it was then: items made later don't exist yet, and an item that
  // closed (or was set aside) after `now` was still open
  const nowIso = new Date(day.now).toISOString();
  const workItems: WorkItemRecord[] = table('work_items').filter((w) => (iso(w.created_at) ?? '') <= nowIso).map((w) => {
    const id = w.id as string;
    const key = byKey.get(id) ?? id;
    const youMin = (w.effort_minutes as number | null) ?? 0;
    const agentMin = Math.max(0, ((w.lead_time_minutes as number | null) ?? youMin) - youMin);
    const dbKind = w.kind as string;
    const kind = (dbKind === 'missed_meeting_followup' ? 'follow_up' : dbKind === 'background_promise' ? 'commitment' : dbKind) as WorkKind;
    const status = w.status as string;
    const reopened = status === 'open' && !!w.last_reopened_at && w.last_reopened_at === w.status_changed_at;
    let state = (status === 'merged' ? 'dismissed' : reopened ? 'reopened' : status) as WorkState;
    if (status !== 'open' && (iso(w.status_changed_at) ?? '') > nowIso) state = 'open';
    const o = overrides[key];
    if (o?.state) state = o.state;
    const t = training.get(id);
    const lnk = links.filter((l) => l.work_item_id === id && l.role === 'stakeholder' && l.person_id);
    const rec = {
      id,
      version: 1,
      kind,
      state,
      title: w.title as string,
      purpose: (w.purpose as string | null) ?? null,
      initiativeId: (w.initiative_id as string | null) ?? null,
      accountId: (w.account_id as string | null) ?? null,
      oppId: (w.opportunity_id as string | null) ?? null,
      servesEventId: (w.deadline_event_id as string | null) ?? null,
      confidence: 'likely',
      why: '',
      whyDetail: null,
      sources: originKind.has(id) ? [{ kind: originKind.get(id)!, label: 'origin' }] : [],
      effort: { youMin, agentMin },
      startBy: null,
      due: o && 'due' in o ? (o.due ?? null) : iso(w.due_at),
      createdAt: iso(w.created_at)!,
      updatedAt: iso(w.updated_at)!,
      ageDays: 0,
      isBackground: w.priority_lane === 'background',
      rank: null,
      rankReasons: [],
      score: null,
      priority: 'medium',
      ...(w.importance !== 'normal' ? { importance: w.importance } : {}),
      ...(o?.dueKind ? { dueKind: o.dueKind } : w.due_kind ? { dueKind: w.due_kind } : {}),
      signals: { customerFacing: false, fromManager: false, boost: 0 },
      userLockedFields: [],
      people: lnk.map((l) => ref(l.person_id)).filter((x): x is NonNullable<typeof x> => !!x),
      counterparty: ref(w.counterparty_person_id),
      training: t ? { course: t.course_title as string, provider: 'Trailhead', minutes: (t.estimated_minutes as number | null) ?? 0, dueDate: t.required_by ? (iso(t.required_by) ?? '').slice(0, 10) : null, overdue: false } : null,
      runIds: [],
    };
    return rec as unknown as WorkItemRecord;
  });

  const prepLinks = links.filter((l) => l.role === 'prep_for' && l.calendar_event_id);
  const extra: CalendarEvent[] = (day.extraMeetings ?? []).map(
    (x, i) =>
      ({
        id: `extra-${i}`,
        title: x.title,
        start: new Date(x.start).toISOString(),
        end: new Date(x.end).toISOString(),
        attendance: 'upcoming',
        isCustomerFacing: !!x.external,
        accountId: null,
        oppId: null,
        attendees: x.external ? [{ id: 'x', name: 'external', isExternal: true }] : [],
        myResponse: 'accepted',
        isAllDay: false,
        eventType: 'default',
        prep: null,
      }) as unknown as CalendarEvent,
  );
  const events: CalendarEvent[] = [...extra, ...table('calendar_events').map((e) => {
    const prep = e.event_type === 'default' ? prepLinks.find((l) => l.calendar_event_id === e.id) : undefined; // a focus block is not a deadline
    return {
      id: e.id as string,
      title: e.title as string,
      start: iso(e.starts_at)!,
      end: iso(e.ends_at)!,
      attendance: e.status === 'cancelled' ? 'cancelled' : e.my_response === 'declined' ? 'declined' : 'upcoming',
      isCustomerFacing: !!e.has_external_attendees,
      accountId: (e.account_id as string | null) ?? null,
      oppId: (e.opportunity_id as string | null) ?? null,
      attendees: e.has_external_attendees ? [{ id: 'x', name: 'external', isExternal: true }] : [],
      myResponse: e.my_response === 'needs_action' ? 'needs_action' : (e.my_response as CalendarEvent['myResponse']),
      isAllDay: !!e.is_all_day,
      eventType: e.event_type as CalendarEvent['eventType'],
      prep: prep ? { workItemId: prep.work_item_id as string, label: 'prep', ready: false } : null,
    } as unknown as CalendarEvent;
  })];
  const opps = new Map(table('opportunities').map((o) => [o.id as string, { id: o.id as string, amount: Number(o.amount) || null }]));
  const drafts = table('drafts').map((d) => ({ id: d.id as string, status: d.status as string, workItemId: (d.work_item_id as string | null) ?? null }));
  return { workItems, people, opps, events, evidence, drafts, keyOf: (id: string) => byKey.get(id) ?? id, idOf: (key: string) => uid('work_items', key) };
}

/** The engine's inputs for a golden day, through the prod builder. */
export function goldenInputs(day: GoldenDay): { inputs: PriorityInputs; keyOf: (id: string) => string; idOf: (key: string) => string } {
  const m = sampleModel(day);
  const now = new Date(day.now);
  const offset = utcOffsetMinutes(day.timezone, now);
  const collections: Record<string, unknown[]> = { workItems: m.workItems, drafts: m.drafts, connectors: [], agentRuns: [] };
  const source = {
    all: (col: string) => collections[col] ?? [],
    get: (col: string, id: string) => (col === 'workItems' ? m.workItems.find((w) => w.id === id) : undefined),
    settings: () => ({ profile: { timezone: day.timezone, workingHours: day.workingHours } }),
  } as unknown as CapacitySource;
  const inputs: PriorityInputs = {
    now: now.toISOString(),
    items: priorityItemsFrom({
      items: m.workItems,
      person: (id) => m.people.get(id),
      oppAmount: (id) => m.opps.get(id)?.amount ?? null,
      evidence: m.evidence,
    }),
    meetings: meetingsFrom(m.events, now),
    // priority@2 plans back over 10 working days with the SE persona's priority block (priority@1.1 ignores both)
    horizonMeetings: meetingsFrom(m.events, now, 16),
    priorityConfig: personaOf({ persona: { id: 'se' } }).priority,
    policy: SE_IC_POLICY,
    workingHours: { ...day.workingHours, utcOffsetMinutes: offset },
    ...capacityInputs(source, now, offset),
  };
  return { inputs, keyOf: m.keyOf, idOf: m.idOf };
}

export function loadGoldenDays(dir = path.resolve(__dirname, 'golden-days')): GoldenDay[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as GoldenDay);
}
