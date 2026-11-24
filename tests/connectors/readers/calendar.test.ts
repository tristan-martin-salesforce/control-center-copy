import { describe, expect, it } from 'vitest';
import { CalendarFetcher, classifyAttendance } from '@/connectors/google/calendar';
import { parseEvents, type ParsedEvent } from '@/connectors/google/parse';
import { clock, FakeGoogle, fx, keyOf, ME, NOW, signal, WINDOW } from './helpers';

const events = () => new FakeGoogle({ get_events: () => fx('calendar', 'events.txt') });

describe('calendar parser', () => {
  it('parses timed and all-day events with attendees, responses, attachments and conferencing', () => {
    const evs = parseEvents(fx('calendar', 'events.txt'));
    expect(evs).toHaveLength(9);
    const declined = evs.find((e) => e.id === 'evt_declined')!;
    expect(declined.meetingLink).toBe('https://meet.google.com/zzz-yyyy-xxx');
    expect(declined.attendees.find((a) => a.email === 'me@example.com')?.response).toBe('declined');
    expect(declined.attendees.find((a) => a.organizer)?.email).toBe('se.two@example.com');
    expect(declined.attachments.map((a) => a.fileId)).toEqual(['1RecordingFileId00000000000000', '1GeminiNotesDocId0000000000000']);
    expect(declined.attachments[1]!.title).toMatch(/Notes by Gemini/);
    const ooo = evs.find((e) => e.id === 'evt_ooo')!;
    expect(ooo.allDay).toBe(true);
    const future = evs.find((e) => e.id === 'evt_future')!;
    expect(future.location).toBe('Conference room 4');
    expect(future.attendees.find((a) => a.email === 'cust.one@customer.example')?.response).toBe('needsAction');
    expect(evs.find((e) => e.id === 'evt_tentative')!.description).toContain('docs.google.com/document/d/1PrepDocId');
  });
});

describe('attendance heuristic', () => {
  const evs = parseEvents(fx('calendar', 'events.txt'));
  const get = (id: string) => classifyAttendance(evs.find((e) => e.id === id)!, evs, ME, NOW);

  it('accepted with no conflicts is attended', () => expect(get('evt_attended')).toMatchObject({ attendance: 'attended', reason: 'accepted' }));
  it('declined is missed', () => expect(get('evt_declined')).toMatchObject({ attendance: 'missed', reason: 'declined' }));
  it('no response is missed', () => expect(get('evt_noresp')).toMatchObject({ attendance: 'missed', reason: 'no_response' }));
  it('two overlapping accepted meetings are uncertain, both ways', () => {
    expect(get('evt_overlap_a')).toMatchObject({ attendance: 'uncertain', reason: 'overlapping_accepted' });
    expect(get('evt_overlap_b')).toMatchObject({ attendance: 'uncertain', reason: 'overlapping_accepted' });
    expect(get('evt_overlap_a').overlapWith).toEqual(['evt_overlap_b']);
  });
  it('tentative is uncertain', () => expect(get('evt_tentative')).toMatchObject({ attendance: 'uncertain', reason: 'tentative' }));
  it('solo blocks, hotel stays and all-day events are n/a', () => {
    expect(get('evt_hotel').attendance).toBe('n/a');
    expect(get('evt_ooo').attendance).toBe('n/a');
  });
  it('future events are upcoming', () => expect(get('evt_future').attendance).toBe('upcoming'));

  it('a meeting inside an OOO block is missed (ooo)', () => {
    const mk = (over: Partial<ParsedEvent>): ParsedEvent => ({
      id: 'x', title: 'T', startsRaw: '', endsRaw: '', start: '', end: '', allDay: false, description: '', location: '', attendeeEmails: [], attendees: [], attachments: [], ...over,
    });
    const ooo = mk({ id: 'ooo', title: 'Out of office', start: '2026-03-10T00:00:00.000Z', end: '2026-03-11T00:00:00.000Z', allDay: true });
    const meet = mk({
      id: 'm', title: 'Customer call', start: '2026-03-10T15:00:00.000Z', end: '2026-03-10T16:00:00.000Z', meetingLink: 'https://meet.google.com/a',
      attendeeEmails: ['me@example.com', 'a@x.com'],
      attendees: [{ email: 'me@example.com', response: 'accepted' }, { email: 'a@x.com', response: 'accepted', organizer: true }],
    });
    expect(classifyAttendance(meet, [ooo, meet], ME, NOW)).toMatchObject({ attendance: 'missed', reason: 'ooo', overlapWith: ['ooo'] });
  });

  it('an organizer who has not responded counts as attended', () => {
    const e = parseEvents(fx('calendar', 'events.txt')).find((x) => x.id === 'evt_noresp')!;
    e.attendees = e.attendees.map((a) => (a.email === 'me@example.com' ? { ...a, organizer: true } : a));
    expect(classifyAttendance(e, [e], ME, NOW)).toMatchObject({ attendance: 'attended', reason: 'organizer' });
  });
});

describe('CalendarFetcher', () => {
  const mk = () => new CalendarFetcher({ google: events(), me: ME, clock });

  it('emits a calendar_event per event with attendance, attachments and the Gemini notes link', async () => {
    const r = await mk().fetch('primary', null, WINDOW, { signal });
    expect(r.items).toHaveLength(9);
    const d = r.items.find((i) => i.externalId === 'evt_declined')!;
    expect(d.kind).toBe('calendar_event');
    expect(d.payload).toMatchObject({ attendance: 'missed', attendanceReason: 'declined', myResponse: 'declined', geminiNotesDocId: '1GeminiNotesDocId0000000000000', conferencing: 'meet', ended: true });
    expect(d.fileRefs).toContain('1GeminiNotesDocId0000000000000');
    expect(d.participants?.find((p) => p.isMe)?.email).toBe('me@example.com');
    expect(d.threadRef).toBe('calendar:evt_declined');
  });

  it('a meeting that just ended emits the notes-poll hint; missed meetings emit missed-meeting; old/future do not', async () => {
    const r = await mk().fetch('primary', null, WINDOW, { signal });
    const hints = (id: string) => (r.items.find((i) => i.externalId === id)!.payload!.hints as string[]);
    expect(hints('evt_attended')).toContain('notes-poll'); // ended 75 min ago, Meet
    expect(hints('evt_declined')).toEqual(['missed-meeting']); // ended 150 min ago: past the poll window
    expect(hints('evt_overlap_a')).toContain('notes-poll');
    expect(hints('evt_future')).toEqual([]);
    expect(hints('evt_hotel')).toEqual([]);
  });

  it('notes-poll stops after 120 minutes', async () => {
    const late = new CalendarFetcher({ google: events(), me: ME, clock: () => new Date(NOW.getTime() + 3 * 3600_000) });
    const r = await late.fetch('primary', null, WINDOW, { signal });
    expect((r.items.find((i) => i.externalId === 'evt_attended')!.payload!.hints as string[])).not.toContain('notes-poll');
  });

  it('coverage lists the calendar range and every event (completeness)', async () => {
    const r = await mk().fetch('primary', null, WINDOW, { signal });
    expect(r.coverage[0]).toMatchObject({ kind: 'calendar_range', ref: 'primary' });
    expect(Date.parse(r.coverage[0]!.to!)).toBeGreaterThanOrEqual(NOW.getTime());
    const refs = r.coverage.filter((c) => c.ref.startsWith('event:')).map((c) => c.ref.slice(6)).sort();
    expect(refs).toEqual(parseEvents(fx('calendar', 'events.txt')).map((e) => e.id).sort());
  });

  it('is idempotent: the same snapshot twice emits nothing the second time', async () => {
    const f = mk();
    const r1 = await f.fetch('primary', null, WINDOW, { signal });
    const r2 = await f.fetch('primary', r1.nextCursor, WINDOW, { signal });
    expect(r2.items).toHaveLength(0);
    expect(r2.nextCursor.value).toBe(r1.nextCursor.value);
  });

  it('re-emits only the events that changed (response change, attachment arrives)', async () => {
    const g = events();
    const f = new CalendarFetcher({ google: g, me: ME, clock });
    const r1 = await f.fetch('primary', null, WINDOW, { signal });
    g.routes.get_events = () => fx('calendar', 'events.txt').replace('cust.one@customer.example: needsAction', 'cust.one@customer.example: accepted');
    const r2 = await f.fetch('primary', r1.nextCursor, WINDOW, { signal });
    expect(r2.items.map((i) => i.externalId)).toEqual(['evt_future']);
    expect(r2.items[0]!.dedupeKey).toBe('cal:evt_future');
    expect(r2.items[0]!.contentHash).not.toBe(r1.items.find((i) => i.externalId === 'evt_future')!.contentHash);
  });

  it('a future event that vanishes is emitted once as cancelled', async () => {
    const g = events();
    const f = new CalendarFetcher({ google: g, me: ME, clock });
    const r1 = await f.fetch('primary', null, WINDOW, { signal });
    const without = fx('calendar', 'events.txt').split('- "ACME_CORP workshop" (Starts: 2026-03-11')[0]!.replace('retrieved 9 events', 'retrieved 8 events');
    g.routes.get_events = () => without;
    const r2 = await f.fetch('primary', r1.nextCursor, WINDOW, { signal });
    expect(r2.items).toHaveLength(1);
    expect(r2.items[0]).toMatchObject({ dedupeKey: 'cal:evt_future:cancelled', payload: { status: 'cancelled' } });
    const r3 = await f.fetch('primary', r2.nextCursor, WINDOW, { signal });
    expect(r3.items).toHaveLength(0);
  });

  it('the status transition upcoming -> ended re-emits the event with attendance', async () => {
    const early = new CalendarFetcher({ google: events(), me: ME, clock: () => new Date('2026-03-10T16:30:00.000Z') });
    const r1 = await early.fetch('primary', null, WINDOW, { signal });
    const before = r1.items.find((i) => i.externalId === 'evt_attended')!; // runs 16:00-16:45Z, still in progress
    expect(before.payload).toMatchObject({ ended: false });
    const late = new CalendarFetcher({ google: events(), me: ME, clock });
    const r2 = await late.fetch('primary', r1.nextCursor, WINDOW, { signal });
    const after = r2.items.find((i) => i.externalId === 'evt_attended')!;
    expect(after.payload).toMatchObject({ ended: true, attendance: 'attended' });
    expect(after.dedupeKey).toBe(before.dedupeKey);
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it('deterministic keys', async () => {
    const a = await mk().fetch('primary', null, WINDOW, { signal });
    const b = await mk().fetch('primary', null, WINDOW, { signal });
    expect(a.items.map(keyOf)).toEqual(b.items.map(keyOf));
  });

  it('listForReconcile lists event refs', async () => {
    const l = await mk().listForReconcile!('primary', { from: '2026-03-08T00:00:00.000Z', to: WINDOW.to }, { signal });
    expect(l).toHaveLength(9);
    expect(l[0]!.ref.startsWith('event:')).toBe(true);
  });
});

/** FS-CAL-1 (first scan, B-080): windows before the live 2-day range are record-only history. */
describe('CalendarFetcher history windows (first scan)', () => {
  // Ten days after the fixture's events: every fixture event is history now.
  const LATER = new Date(NOW.getTime() + 10 * 86400_000);
  const HIST = { from: '2026-03-08T00:00:00.000Z', to: '2026-03-12T00:00:00.000Z' };

  it('lists exactly the window, emits every event oldest first tagged history, and asks for no interpretation', async () => {
    const g = events();
    const f = new CalendarFetcher({ google: g, me: ME, clock: () => LATER });
    expect(f.isHistory(HIST, LATER)).toBe(true);
    const r = await f.fetch('primary', null, HIST, { signal, limit: 3 });
    expect(g.calls[0]!.args).toMatchObject({ time_min: HIST.from, time_max: HIST.to });
    expect(r.recordOnly).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.items).toHaveLength(9); // the agent limit does not apply: nothing goes to the agent
    const starts = r.items.map((i) => Date.parse(i.occurredAt));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(r.items.every((i) => (i.payload!.hints as string[]).includes('history'))).toBe(true);
    expect(r.items.find((i) => i.externalId === 'evt_declined')!.payload).toMatchObject({ attendance: 'missed', ended: true });
    expect(r.coverage[0]).toMatchObject({ kind: 'calendar_range', ref: 'primary', from: HIST.from, to: HIST.to });
    expect(r.nextCursor.at).toBe(HIST.to);
  });

  it('keeps the live cursor value, and never reports cancellations from a history listing', async () => {
    const live = await new CalendarFetcher({ google: events(), me: ME, clock }).fetch('primary', null, WINDOW, { signal });
    const g = new FakeGoogle({ get_events: () => 'No events found.' });
    const r = await new CalendarFetcher({ google: g, me: ME, clock: () => LATER }).fetch('primary', live.nextCursor, HIST, { signal });
    expect(r.items).toHaveLength(0);
    expect(r.nextCursor.value).toBe(live.nextCursor.value);
    expect(r).toMatchObject({ complete: true, recordOnly: true });
  });

  it('a full page claims only up to its last start; the rest is a continuation', async () => {
    const f = new CalendarFetcher({ google: events(), me: ME, clock: () => LATER, maxEvents: 9 });
    const r = await f.fetch('primary', null, HIST, { signal });
    const lastStart = r.items.at(-1)!.occurredAt;
    expect(r.complete).toBe(false);
    expect(r.nextCursor.at).toBe(lastStart);
    expect(r.coverage[0]!.to).toBe(lastStart);
  });

  it('a window that reaches into the live range stays a snapshot run', async () => {
    const f = new CalendarFetcher({ google: events(), me: ME, clock });
    expect(f.isHistory(WINDOW, NOW)).toBe(false);
    const r = await f.fetch('primary', null, WINDOW, { signal });
    expect(r.recordOnly).toBeUndefined();
  });
});
